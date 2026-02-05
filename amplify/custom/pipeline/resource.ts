import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudfront_origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { RemovalPolicy, Stack, CfnOutput } from 'aws-cdk-lib';

// ============================================================================
// defineFrontend - S3 + CloudFront hosting
// ============================================================================

export interface FrontendProps {
  /** Optional bucket name (auto-generated if not provided) */
  bucketName?: string;
}

export interface FrontendOutput {
  bucket: s3.Bucket;
  distribution: cloudfront.Distribution;
  url: string;
}

/**
 * Define frontend hosting infrastructure (S3 + CloudFront)
 */
export function defineFrontend(stack: Stack, props?: FrontendProps): FrontendOutput {
  const bucket = new s3.Bucket(stack, 'FrontendBucket', {
    bucketName: props?.bucketName,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    removalPolicy: RemovalPolicy.DESTROY,
    autoDeleteObjects: true,
  });

  const distribution = new cloudfront.Distribution(stack, 'Distribution', {
    defaultBehavior: {
      origin: cloudfront_origins.S3BucketOrigin.withOriginAccessControl(bucket),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    },
    defaultRootObject: 'index.html',
    errorResponses: [
      {
        httpStatus: 404,
        responseHttpStatus: 200,
        responsePagePath: '/index.html', // SPA routing
      },
    ],
  });

  const url = `https://${distribution.distributionDomainName}`;

  new CfnOutput(stack, 'CloudFrontURL', { value: url });
  new CfnOutput(stack, 'BucketName', { value: bucket.bucketName });

  return { bucket, distribution, url };
}


// ============================================================================
// definePipeline - CodePipeline with backend + frontend deployment
// ============================================================================

export interface PipelineProps {
  /** GitHub repository owner */
  githubOwner: string;
  /** GitHub repository name */
  githubRepo: string;
  /** GitHub branch to deploy */
  githubBranch: string;
  /** Secrets Manager secret name for GitHub token */
  githubTokenSecretName: string;
  /** Stack name for Amplify backend deployment */
  stackName: string;
  /** Frontend hosting (from defineFrontend) */
  frontend: FrontendOutput;
}

export interface PipelineOutput {
  pipeline: codepipeline.Pipeline;
}

/**
 * Define CI/CD pipeline that deploys Amplify Gen2 backend (using --custom-pipeline)
 * and frontend to S3 + CloudFront
 */
export function definePipeline(stack: Stack, props: PipelineProps): PipelineOutput {
  const { githubOwner, githubRepo, githubBranch, githubTokenSecretName, stackName, frontend } = props;

  const githubToken = secretsmanager.Secret.fromSecretNameV2(stack, 'GitHubToken', githubTokenSecretName);

  const sourceOutput = new codepipeline.Artifact('SourceOutput');
  const backendOutput = new codepipeline.Artifact('BackendOutput');

  // Backend deployment project
  const backendProject = new codebuild.PipelineProject(stack, 'BackendBuild', {
    projectName: `${stackName}-backend`,
    environment: {
      buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
      computeType: codebuild.ComputeType.MEDIUM,
    },
    environmentVariables: {
      BRANCH_NAME: { value: githubBranch },
      STACK_NAME: { value: stackName },
    },
    buildSpec: codebuild.BuildSpec.fromObject({
      version: '0.2',
      phases: {
        install: {
          'runtime-versions': { nodejs: 20 },
          commands: ['npm ci', 'npx ampx --version'],
        },
        build: {
          commands: [
            'echo "Deploying backend with --custom-pipeline..."',
            'npx ampx pipeline-deploy --branch $BRANCH_NAME --custom-pipeline --stack-name $STACK_NAME --outputs-out-dir . --outputs-format json',
            'cat amplify_outputs.json',
          ],
        },
      },
      artifacts: { files: ['amplify_outputs.json'] },
      cache: { paths: ['node_modules/**/*'] },
    }),
  });

  backendProject.addToRolePolicy(new iam.PolicyStatement({
    actions: ['cloudformation:*', 'iam:*', 'cognito-idp:*', 'appsync:*', 'dynamodb:*', 'lambda:*', 's3:*', 'ssm:*', 'secretsmanager:GetSecretValue', 'logs:*', 'sts:AssumeRole'],
    resources: ['*'],
  }));


  // Frontend build + deploy project
  const frontendProject = new codebuild.PipelineProject(stack, 'FrontendBuild', {
    projectName: `${stackName}-frontend`,
    environment: {
      buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
      computeType: codebuild.ComputeType.MEDIUM,
    },
    environmentVariables: {
      BUCKET_NAME: { value: frontend.bucket.bucketName },
      DISTRIBUTION_ID: { value: frontend.distribution.distributionId },
    },
    buildSpec: codebuild.BuildSpec.fromObject({
      version: '0.2',
      phases: {
        install: {
          'runtime-versions': { nodejs: 20 },
          commands: ['npm ci'],
        },
        pre_build: {
          commands: [
            'cp $CODEBUILD_SRC_DIR_BackendOutput/amplify_outputs.json .',
            'cat amplify_outputs.json',
          ],
        },
        build: {
          commands: ['npm run build'],
        },
        post_build: {
          commands: [
            'aws s3 sync dist/ s3://$BUCKET_NAME/ --delete',
            'aws cloudfront create-invalidation --distribution-id $DISTRIBUTION_ID --paths "/*"',
          ],
        },
      },
    }),
  });

  frontend.bucket.grantReadWrite(frontendProject);
  frontendProject.addToRolePolicy(new iam.PolicyStatement({
    actions: ['cloudfront:CreateInvalidation'],
    resources: [`arn:aws:cloudfront::${stack.account}:distribution/${frontend.distribution.distributionId}`],
  }));

  // Create pipeline
  const pipeline = new codepipeline.Pipeline(stack, 'Pipeline', {
    pipelineName: `${stackName}-pipeline`,
  });

  pipeline.addStage({
    stageName: 'Source',
    actions: [new codepipeline_actions.GitHubSourceAction({
      actionName: 'GitHub',
      owner: githubOwner,
      repo: githubRepo,
      branch: githubBranch,
      oauthToken: githubToken.secretValue,
      output: sourceOutput,
      trigger: codepipeline_actions.GitHubTrigger.WEBHOOK,
    })],
  });

  pipeline.addStage({
    stageName: 'DeployBackend',
    actions: [new codepipeline_actions.CodeBuildAction({
      actionName: 'Backend',
      project: backendProject,
      input: sourceOutput,
      outputs: [backendOutput],
    })],
  });

  pipeline.addStage({
    stageName: 'DeployFrontend',
    actions: [new codepipeline_actions.CodeBuildAction({
      actionName: 'Frontend',
      project: frontendProject,
      input: sourceOutput,
      extraInputs: [backendOutput],
    })],
  });

  new CfnOutput(stack, 'PipelineName', { value: pipeline.pipelineName });

  return { pipeline };
}
