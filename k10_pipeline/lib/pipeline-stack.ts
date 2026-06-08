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

    // ── 1. Source ──────────────────────────────────────────────────────────────
    // This MUST be the monorepo that contains ALL THREE folders:
    //   k10_backend/   (Dockerfile — built by CDK during synth)
    //   k10_frontend/  (React app — built by the DeployFrontend ShellStep)
    //   k10_pipeline/  (this CDK app — compiled in the Synth step)
    //
    // ❶ Push all three folders to one GitHub repo if you haven't already.
    // ❷ Create a GitHub connection in AWS Console → Developer Tools → Connections
    //    and authorise it for that monorepo.
    // ❸ Replace the two values below.
    const source = CodePipelineSource.connection(
      'YOUR_GITHUB_USERNAME/YOUR_MONOREPO_NAME', // e.g. 'emmadoran/k10-report-app'
      'main',
      {
        // Paste the ARN from AWS Console → Developer Tools → Connections
        // e.g. 'arn:aws:codestar-connections:us-east-1:123456789012:connection/abcd1234-...'
        connectionArn: 'arn:aws:codestar-connections:REGION:ACCOUNT_ID:connection/CONNECTION_ID',
      },
    );

    // ── 2. Pipeline ────────────────────────────────────────────────────────────
    const pipeline = new CodePipeline(this, 'K10Pipeline', {
      pipelineName: 'K10ReportPipeline',
      // Enable Docker so CDK can build the backend container image during synth.
      dockerEnabledForSynth: true,

      // The synth step compiles the CDK TypeScript app itself.
      // CodePipeline will run this every time you push to 'main'.
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
          // VITE_API_BASE_URL is injected from the ALB DNS name above
          'npm run build',
          // Sync build output to the S3 bucket
          'aws s3 sync dist/ s3://$BUCKET_NAME --delete',
          // Invalidate CloudFront so users get the latest version immediately
          'aws cloudfront create-invalidation --distribution-id $DISTRIBUTION_ID --paths "/*"',
        ],
      }),
    );
  }
}
