import * as cdk from 'aws-cdk-lib';
import { BlockPublicAccess, Bucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export class InfrastructureStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Retrieve enviroment to work with
    const env = props?.env || 'dev';

    // Retrieve configuration for the S3 bucket, based on the environemnt
    const importBucketConfig = this.node.tryGetContext(`${env}.importBucket`)

    // Create S3 bucket
    const importBucket = new Bucket(scope, 'ImportBucket', {
      bucketName: `importbucket-${env}`,
      versioned: importBucketConfig.versioned || true,
      blockPublicAccess: importBucketConfig.blockPublicAccess || BlockPublicAccess.BLOCK_ALL
    });


  }
}
