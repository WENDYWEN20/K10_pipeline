import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';

/**
 * Deploys the FastAPI 10-K backend as an ECS Fargate service behind an
 * Application Load Balancer.
 *
 * The MongoDB connection string is read from AWS Secrets Manager at runtime
 * (never stored in environment variables or source code).
 *
 * Before deploying, create the secret once:
 *   aws secretsmanager create-secret \
 *     --name k10/mongo-uri \
 *     --secret-string '{"MONGO_URI":"mongodb+srv://user:pass@cluster.mongodb.net/tenk_extraction"}'
 */
export class BackendStack extends cdk.Stack {
  /** ALB DNS name, e.g. http://k10-backend-alb-XXXXX.us-east-1.elb.amazonaws.com */
  public readonly apiUrlOutput: cdk.CfnOutput;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── VPC ──────────────────────────────────────────────────────────────────
    // 2 AZs with public + private subnets. NAT gateway allows the Fargate
    // task to reach MongoDB Atlas (outbound HTTPS) without a public IP.
    const vpc = new ec2.Vpc(this, 'K10Vpc', {
      maxAzs: 2,
      natGateways: 1, // one NAT gateway to keep costs low
    });

    // ── ECS Cluster ───────────────────────────────────────────────────────────
    const cluster = new ecs.Cluster(this, 'K10Cluster', {
      vpc,
      containerInsights: true,
    });

    // ── Docker image (built from k10_backend/Dockerfile) ─────────────────────
    // CDK builds this image during `cdk synth`, pushes it to an ECR staging
    // repository, and references the digest in the CloudFormation template.
    const backendImage = new ecrAssets.DockerImageAsset(this, 'BackendImage', {
      directory: path.join(__dirname, '../../k10_backend'),
      platform: ecrAssets.Platform.LINUX_AMD64,
    });

    // ── Secrets ───────────────────────────────────────────────────────────────
    // The secret must be created manually once (see the docstring above).
    // It stores a JSON object: { "MONGO_URI": "...", "MONGO_DB_NAME": "..." }
    const mongoSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'MongoSecret',
      'k10/mongo-uri',
    );

    // ── Fargate Task Definition ───────────────────────────────────────────────
    const taskDef = new ecs.FargateTaskDefinition(this, 'BackendTaskDef', {
      memoryLimitMiB: 1024,
      cpu: 512,
    });

    const logGroup = new logs.LogGroup(this, 'BackendLogs', {
      logGroupName: '/k10/backend',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    taskDef.addContainer('BackendContainer', {
      image: ecs.ContainerImage.fromDockerImageAsset(backendImage),
      portMappings: [{ containerPort: 8000, protocol: ecs.Protocol.TCP }],
      // Inject MongoDB credentials at runtime from Secrets Manager —
      // they are never visible in the ECS console or CloudFormation template.
      secrets: {
        MONGO_URI: ecs.Secret.fromSecretsManager(mongoSecret, 'MONGO_URI'),
        MONGO_DB_NAME: ecs.Secret.fromSecretsManager(mongoSecret, 'MONGO_DB_NAME'),
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'k10-backend',
        logGroup,
      }),
      // Tell ECS to restart the container if the health check fails 3 times
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:8000/docs || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        retries: 3,
        startPeriod: cdk.Duration.seconds(30),
      },
    });

    // ── Fargate Service ───────────────────────────────────────────────────────
    const service = new ecs.FargateService(this, 'BackendService', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: 1,
      // Deploy new containers before removing old ones (rolling update)
      circuitBreaker: { rollback: true },
      assignPublicIp: false, // tasks live in private subnets
    });

    // ── Application Load Balancer ─────────────────────────────────────────────
    const lb = new elbv2.ApplicationLoadBalancer(this, 'BackendALB', {
      vpc,
      internetFacing: true,
    });

    const listener = lb.addListener('HttpListener', {
      port: 80,
      open: true,
    });

    listener.addTargets('BackendTargets', {
      port: 8000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      healthCheck: {
        path: '/docs',
        healthyHttpCodes: '200',
        interval: cdk.Duration.seconds(30),
      },
      // Keep connections alive during deployments
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // ── Outputs ───────────────────────────────────────────────────────────────
    this.apiUrlOutput = new cdk.CfnOutput(this, 'BackendApiUrl', {
      value: `http://${lb.loadBalancerDnsName}`,
      description: 'ALB URL for the FastAPI backend — used as VITE_API_BASE_URL in the frontend build',
      exportName: 'K10BackendApiUrl',
    });
  }
}
