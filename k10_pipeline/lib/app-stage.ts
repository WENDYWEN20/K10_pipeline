import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { BackendStack } from './backend-stack';
import { FrontendStack } from './frontend-stack';

/**
 * A CDK Stage groups related stacks that are deployed together.
 * Both stacks are in the same AWS account/region, so CloudFormation
 * cross-stack references work without needing SSM exports.
 *
 * The CfnOutput references are used by the pipeline's post-deploy
 * ShellStep (DeployFrontend) to build and upload the React app.
 */
export class K10AppStage extends cdk.Stage {
  /** Forwarded from BackendStack — injected as VITE_API_BASE_URL during the frontend build */
  public readonly backendApiUrlOutput: cdk.CfnOutput;

  /** Forwarded from FrontendStack — used to sync dist/ after the build */
  public readonly frontendBucketNameOutput: cdk.CfnOutput;

  /** Forwarded from FrontendStack — used to invalidate the CDN cache */
  public readonly frontendDistributionIdOutput: cdk.CfnOutput;

  constructor(scope: Construct, id: string, props?: cdk.StageProps) {
    super(scope, id, props);

    const backend = new BackendStack(this, 'Backend');
    const frontend = new FrontendStack(this, 'Frontend');

    // Expose outputs so pipeline-stack.ts can reference them in envFromCfnOutputs
    this.backendApiUrlOutput = backend.apiUrlOutput;
    this.frontendBucketNameOutput = frontend.bucketNameOutput;
    this.frontendDistributionIdOutput = frontend.distributionIdOutput;
  }
}
