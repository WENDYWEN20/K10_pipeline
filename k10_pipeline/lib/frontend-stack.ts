import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Provisions the hosting infrastructure for the React/Vite frontend:
 *   - Private S3 bucket (no public access)
 *   - CloudFront distribution with OAC (Origin Access Control)
 *   - HTTPS redirect + SPA 404→index.html fallback
 *
 * NOTE: This stack does NOT upload any files. The pipeline's post-deploy
 * ShellStep (DeployFrontend) builds the Vite app and syncs dist/ to S3.
 */
export class FrontendStack extends cdk.Stack {
  public readonly bucketNameOutput: cdk.CfnOutput;
  public readonly distributionIdOutput: cdk.CfnOutput;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── S3 Bucket ─────────────────────────────────────────────────────────────
    // Fully private — only CloudFront can read objects via OAC.
    const siteBucket = new s3.Bucket(this, 'FrontendBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,   // safe for this use case
      autoDeleteObjects: true,
      enforceSSL: true,
    });

    // ── CloudFront Origin Access Control ──────────────────────────────────────
    const oac = new cloudfront.S3OriginAccessControl(this, 'OAC', {
      description: 'OAC for K10 frontend bucket',
    });

    // Grant CloudFront permission to read from the bucket
    siteBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudFrontRead',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        actions: ['s3:GetObject'],
        resources: [`${siteBucket.bucketArn}/*`],
        conditions: {
          StringEquals: {
            'AWS:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/*`,
          },
        },
      }),
    );

    // ── CloudFront Distribution ───────────────────────────────────────────────
    const distribution = new cloudfront.Distribution(this, 'FrontendCDN', {
      comment: 'K10 Report App — React frontend',
      defaultRootObject: 'index.html',

      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket, { originAccessControl: oac }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        compress: true,
      },

      // React Router SPA: return index.html for any path CloudFront can't find
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],

      priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // US + Europe only (cheapest)
    });

    // ── Outputs ───────────────────────────────────────────────────────────────
    this.bucketNameOutput = new cdk.CfnOutput(this, 'FrontendBucketName', {
      value: siteBucket.bucketName,
      description: 'S3 bucket that holds the built React files',
      exportName: 'K10FrontendBucketName',
    });

    this.distributionIdOutput = new cdk.CfnOutput(this, 'FrontendDistributionId', {
      value: distribution.distributionId,
      description: 'CloudFront distribution ID — used to invalidate the cache after a deploy',
      exportName: 'K10FrontendDistributionId',
    });

    new cdk.CfnOutput(this, 'FrontendUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'Public URL of the React frontend',
      exportName: 'K10FrontendUrl',
    });
  }
}
