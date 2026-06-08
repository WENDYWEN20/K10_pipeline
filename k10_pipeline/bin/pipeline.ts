#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { PipelineStack } from '../lib/pipeline-stack';

const app = new cdk.App();

new PipelineStack(app, 'K10PipelineStack', {
  env: {
    // CDK_DEFAULT_ACCOUNT and CDK_DEFAULT_REGION are resolved from your
    // AWS CLI profile. Run: export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
    account: process.env.CDK_DEFAULT_ACCOUNT ?? '391556258782',
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: '10-K Report App — CI/CD Pipeline (CDK Pipelines + CodePipeline)',
});
