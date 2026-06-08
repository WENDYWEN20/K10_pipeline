import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  CodePipeline,
  CodePipelineSource,
  ShellStep,
} from 'aws-cdk-lib/pipelines';
import { K10AppStage } from './app-stage';

/**
 * The self-mutating CDK Pipeline stack.
 *
 * On first deploy this creates the CodePipeline. On every subsequent push to
 * the configured branch, CodePipeline re-synthesises the CDK app and
 * updates itself before deploying the application stacks.
 *
 * Prerequisites (one-time setup):
 *   1. Create a GitHub connection in the AWS console under
 *      Developer Tools → Connections and copy the ARN into GITHUB_CONNECTION_ARN below.
 *   2. Store your MongoDB URI in Secrets Manager:
 *      aws secretsmanager create-secret --name k10/mongo-uri --secret-string "mongodb+srv://..."
 *   3. Bootstrap the account/region: npx cdk bootstrap
 */
export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── 1. Source ─────────────────────────────────────────────────────────────
    // Single monorepo: https://github.com/WENDYWEN20/K10_pipeline
    // Structure inside the repo:
    //   k10_backend/   ← FastAPI + Dockerfile
    //   k10_frontend/  ← React/Vite app
    //   k10_pipeline/  ← this CDK app (package.json here)
    const source = CodePipelineSource.connection(
      'WENDYWEN20/K10_pipeline',
      'main',
      {
        connectionArn: 'arn:aws:codeconnections:us-east-1:391556258782:connection/3ff263be-f365-4212-b9e5-453eb1ad89cc',
      },
    );

    // ── 2. Pipeline ────────────────────────────────────────────────────────────
    const pipeline = new CodePipeline(this, 'K10Pipeline', {
      pipelineName: 'K10ReportPipeline',
      // Enable Docker so CDK can build the backend container image during synth.
      dockerEnabledForSynth: true,

      // Synth step: cd into k10_pipeline/ (the CDK app subfolder) before running commands.
      // path.join(__dirname, '../../k10_backend') in backend-stack.ts resolves correctly:
      //   __dirname  = <checkout>/k10_pipeline/lib
      //   ../../      = <checkout>/              (monorepo root)
      //   k10_backend = <checkout>/k10_backend   ✓
      synth: new ShellStep('Synth', {
        input: source,
        commands: [
          'cd k10_pipeline',
          'npm ci',
          'npx cdk synth --output cdk.out',
        ],
        primaryOutputDirectory: 'k10_pipeline/cdk.out',
      }),
    });

    // ── 3. Application stage (Backend + Frontend infra) ────────────────────────
    const appStage = new K10AppStage(this, 'Production', {
      env: {
        account: this.account,
        region: this.region,
      },
    });

    const stage = pipeline.addStage(appStage);

    // ── 4. Post-deploy: build the React app and sync it to S3 ─────────────────
    // This runs AFTER CloudFormation has deployed/updated both stacks,
    // so BUCKET_NAME, DISTRIBUTION_ID, and VITE_API_BASE_URL are available.
    stage.addPost(
      new ShellStep('DeployFrontend', {
        input: source,
        // Inject CloudFormation outputs as environment variables
        envFromCfnOutputs: {
          BUCKET_NAME: appStage.frontendBucketNameOutput,
          DISTRIBUTION_ID: appStage.frontendDistributionIdOutput,
          VITE_API_BASE_URL: appStage.backendApiUrlOutput,
        },
        commands: [
          'cd k10_frontend',
          'npm ci',
          'npm run build',
          'aws s3 sync dist/ s3://$BUCKET_NAME --delete',
          'aws cloudfront create-invalidation --distribution-id $DISTRIBUTION_ID --paths "/*"',
        ],
      }),
    );
  }
}
