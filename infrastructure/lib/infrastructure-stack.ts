import * as cdk from 'aws-cdk-lib';
import { Code, Function, Runtime } from 'aws-cdk-lib/aws-lambda';
import { BlockPublicAccess, Bucket, EventType } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { getDurationInSeconds, getLambdaArchitecture } from '../utils/utils';
import { Effect, ManagedPolicy, PolicyDocument, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { LambdaDestination } from 'aws-cdk-lib/aws-s3-notifications';
import { AttributeType, Billing, TableClass, TableEncryptionV2, TableV2 } from 'aws-cdk-lib/aws-dynamodb';

export class InfrastructureStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    
    // Retrieve enviroment to work with
    const env = this.node.tryGetContext('env') || 'dev';

    // Retrieve configuration for the current environment.
    // This is used to retrieve configurations for the stack
    const envsConfig = this.node.tryGetContext(`envs`);

    // Retrieve project name (used as prefix for all resources)
    const projectName = envsConfig[env].projectName;



    // Retrieve S3 bucket configuration for import bucket resource
    const importBucketConfig = envsConfig[env].importBucket;

    // Create S3 bucket
    const importBucket = new Bucket(this, 'ImportBucket', {
      bucketName: `${projectName}-importbucket-${env}`,
      versioned: importBucketConfig?.versioned || true,
      blockPublicAccess: importBucketConfig?.blockPublicAccess || BlockPublicAccess.BLOCK_ALL,
      enforceSSL: importBucketConfig?.enforceSSL || true
    });



    // Create IAM Role used by Parser Lambda
    const parserLambdaIAMRole = new Role(this, 'ParserLambdaIAMRole', {
      roleName: `${projectName}-parser-role-${env}`,
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      description: "IAM Role used by Parser Lambda",
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole")
      ]
    });

    // Attach the inline policy to get objects from S3
    parserLambdaIAMRole.addToPolicy(new PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [importBucket.bucketArn],
      effect: Effect.ALLOW
    }))



    // Retrieve Lambda configuration for Parser Lambda
    const parserLambdaConfig = envsConfig[env].parserLambda;

    // Create Lambda to parse the CSV stored in S3 bucket
    const parserLambda = new Function(this, 'ParserLambda', {
      functionName: `${projectName}-parser-${env}`,
      description: "Lambda function used as event notification from S3 bucket to parse the CSV file and upload it to DynamoDB table",
      code: Code.fromAsset(__dirname + '../../../lambdas/parser/dist'),
      handler: 'index.handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: getLambdaArchitecture(parserLambdaConfig.architecture),
      environment: parserLambdaConfig?.enviroment || null,
      memorySize: parserLambdaConfig?.memorySize || 128,
      timeout: getDurationInSeconds(parserLambdaConfig?.timeout),
      role: parserLambdaIAMRole
    });

    // Grant permission to invoke the Lambda function by S3
    parserLambda.addPermission('AllowS3Invoke', {
      principal: new ServicePrincipal('s3.amazonaws.com'),
      sourceArn: importBucket.bucketArn
    })

    // Create the event notification for S3 to invoke the Lambda
    // POST Object created
    importBucket.addEventNotification(
      EventType.OBJECT_CREATED_POST,
      new LambdaDestination(parserLambda)
    );

    // PUT Object created
    importBucket.addEventNotification(
      EventType.OBJECT_CREATED_PUT,
      new LambdaDestination(parserLambda)
    );


    // Retrieve DynamoDB table configuration
    const parsedTableConfig = envsConfig[env].parsedTable;

    // Create dynamoDB Table which will store the parsed CSV data
    const parsedTable = new TableV2(this, 'ParsedTable', {
      tableName: `${projectName}-parsed-data-${env}`,
      partitionKey: { name: 'id', type: AttributeType.STRING },
      billing: Billing.onDemand(),
      deletionProtection: parsedTableConfig.deletionProtection || false,
      encryption: TableEncryptionV2.dynamoOwnedKey(),
      tableClass: TableClass.STANDARD
    });

    // Add to the Lambda IAM role the policy to interact with DynamoDB   
    parserLambdaIAMRole.addToPolicy(new PolicyStatement({
      actions: [
        'dynamodb:BatchWriteItem',
        'dynamodb:BatchGetItem',
        'dynamodb:DescribeTable',
        'dynamodb:GetItem',
        'dynamodb:PutItem'
      ],
      resources: [parsedTable.tableArn],
      effect: Effect.ALLOW
    }));


    // Lastly, add tags to resources
    cdk.Tags.of(this).add('project', projectName);
    cdk.Tags.of(this).add('env', env);
  }
}
