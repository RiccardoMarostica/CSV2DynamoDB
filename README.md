# CSV to DynamoDB Importer

## Project Overview
This project automates the process of importing CSV data into a DynamoDB table. The workflow is as follows:

- A CSV file is uploaded to an S3 bucket.
- This upload triggers a Lambda function that:
  - Downloads the CSV file from S3.
  - Parses the CSV content, where the first row contains headers.
  - Maps each row into DynamoDB items, using the first column as the partition key.
  - Batch writes the items into a DynamoDB table.
- In case of processing errors or retries exhausted, failed events are sent to a configured Dead Letter Queue (DLQ) for later inspection or reprocessing.


## Infrastructure

The infrastructure is managed using AWS CDK (in TypeScript), located in the `infrastructure/` folder.

### Resources Created

- **S3 Bucket**: Receives CSV file uploads that trigger the Lambda.
- **Lambda Function**: Runs the CSV parser and DynamoDB uploader logic.
- **DynamoDB Table**: Stores the parsed CSV data.
- **SQS Dead Letter Queue (DLQ)**: Captures failed Lambda invocations after retries.
- **IAM Roles & Policies**: Provide necessary permissions for Lambda to access S3, DynamoDB, and SQS.

### Environment Management

The project uses the `cdk.json` file for environment configuration such as:

- AWS account and region settings.
- DynamoDB configuration parameters.
- Lambda configuration parameters.
- S3 configuration parameters.
- Dead Letter Queue configuration parameters.

You can customize these values before deploying the stack.


## Lambda Code Overview

The Lambda function is located in the `lambdas/` folder and written in TypeScript.

Key aspects:

- **S3 Event Trigger**: The Lambda receives events when a CSV file is uploaded.
- **CSV Parsing**: Uses an advanced CSV parser to handle complex CSV formats, reading the header row as attribute keys.
- **Dynamic Partition Key Handling**: Queries the DynamoDB table to detect the partition key’s attribute type (string or number) and formats data accordingly.
- **Batch Writes to DynamoDB**: To efficiently store data, the Lambda uses DynamoDB’s `batchWriteItem` API with retry and exponential backoff logic for unprocessed items.
- **Error Handling and Logging**: Failures are logged with Pino, and errors cause the Lambda to fail so that the event is routed to the DLQ.
- **DLQ Integration**: The Lambda is configured with an SQS Dead Letter Queue to capture failed event payloads for later analysis.


## Useful Commands

### CDK Commands (in `infrastructure/` folder)

- **Bootstrap AWS environment**  
  ```
  npm run cdk:bootstrap --profile <PROFILE_NAME>
  ```
- **Synth Infrastructure**
  ```
  npm run cdk:synth
  ```
- **Deploy Infrastructure**
  ```
  npm run cdk:deploy --profile <PROFILE_NAME>
  ```
- **Diff local changes against deployed stack**
  ```
  npm run cdk:deploy --profile <PROFILE_NAME>
  ```

where ```<PROFILE_NAME>``` is an AWS account profile in your configuration file (AWS CLI).

### Lambda Commands (in `lambdas/parser/` folder)

- **Compile Typescript code**
  ```
  npm run tsc:compile
  ```

**Note**: Before deploying your CDK Stack into AWS, we recommend to compile the Lambda code for any changes.