import { S3Event } from "aws-lambda";
import {
    S3Client,
    GetObjectCommand,
} from "@aws-sdk/client-s3";
import {
    DynamoDBClient,
    DescribeTableCommand,
    BatchWriteItemCommand,
    WriteRequest,
    AttributeValue
} from "@aws-sdk/client-dynamodb";
import { parse } from "csv-parse/sync";

// Max batch size for DynamoDB
const MAX_BATCH_SIZE = 25;

export class CSVToDynamoImporter {

    // Create instances for DynamoDB and S3
    private s3Client = new S3Client({});
    private ddbClient = new DynamoDBClient({});

    private tableName = process.env.DYNAMO_TABLE_NAME!;

    private partitionKeyName: string = "";
    private partitionKeyType: "S" | "N" = "S";

    constructor() {
        if (!this.tableName) {
            throw new Error("Environment variable DYNAMO_TABLE_NAME is not set.");
        }
    }

    /**
     * @description Function to handle S3 event received by the Lambda function
     * @param event S3 Event
     */
    async handleEvent(event: S3Event): Promise<void> {
        
        // Retrieve the bucket and key which will be required to get the CSV file in S3
        const record = event.Records[0];
        const bucket = record.s3.bucket.name;
        const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

        // Load the partition key data
        await this.loadPartitionKeyMetadata();

        // const csvContent = await this.getCSVFileContent(bucket, key);
        // const rows = this.parseCSV(csvContent);
        // await this.processRows(rows);
    }

    private async loadPartitionKeyMetadata(): Promise<void> {
        const describeCommand = new DescribeTableCommand({ TableName: this.tableName });
        const response = await this.ddbClient.send(describeCommand);

        const keySchema = response.Table?.KeySchema?.find(k => k.KeyType === "HASH");
        const attrDef = response.Table?.AttributeDefinitions?.find(
            a => a.AttributeName === keySchema?.AttributeName
        );

        if (!keySchema || !attrDef) {
            throw new Error("Unable to determine partition key schema from DynamoDB table.");
        }

        this.partitionKeyName = keySchema.AttributeName!;
        this.partitionKeyType = attrDef.AttributeType as "S" | "N";
    }

    private async getCSVFileContent(bucket: string, key: string): Promise<string> {
        const command = new GetObjectCommand({ Bucket: bucket, Key: key });
        const response = await this.s3Client.send(command);

        if (!response.Body || !("transformToString" in response.Body)) {
            throw new Error("S3 response body missing or not a valid stream.");
        }

        return await response.Body.transformToString();
    }

    private parseCSV(content: string): Record<string, string>[] {
        try {
            return parse(content, {
                columns: true,          // Use first line as header keys
                skip_empty_lines: true,
                trim: true,
            }) as Record<string, string>[];
        } catch (error) {
            console.error("CSV parsing failed:", error);
            throw new Error("Failed to parse CSV content.");
        }
    }

    private async processRows(rows: Record<string, string>[]): Promise<void> {
        let batch: WriteRequest[] = [];

        for (const row of rows) {
            const item = this.mapRowToDynamoItem(row);
            batch.push({ PutRequest: { Item: item } });

            if (batch.length === MAX_BATCH_SIZE) {
                await this.batchWriteItems(batch);
                batch = [];
            }
        }

        if (batch.length > 0) {
            await this.batchWriteItems(batch);
        }
    }

    private mapRowToDynamoItem(row: Record<string, string>): Record<string, AttributeValue> {
        const item: Record<string, AttributeValue> = {};

        for (const [key, value] of Object.entries(row)) {
            if (!value) continue;

            if (key === this.partitionKeyName) {
                item[key] = this.partitionKeyType === "N" && !isNaN(Number(value))
                    ? { N: String(Number(value)) }
                    : { S: value };
            } else {
                item[key] = { S: value };
            }
        }

        return item;
    }

    private async batchWriteItems(writeRequests: WriteRequest[]): Promise<void> {
        const command = new BatchWriteItemCommand({
            RequestItems: {
                [this.tableName]: writeRequests,
            },
        });

        const response = await this.ddbClient.send(command);
        let unprocessed = response.UnprocessedItems?.[this.tableName] ?? [];

        while (unprocessed.length > 0) {
            const retryCommand = new BatchWriteItemCommand({
                RequestItems: {
                    [this.tableName]: unprocessed,
                },
            });
            const retryResponse = await this.ddbClient.send(retryCommand);
            unprocessed = retryResponse.UnprocessedItems?.[this.tableName] ?? [];
        }
    }
}

export const handler = async (event: S3Event) => {
    const importer = new CSVToDynamoImporter();
    await importer.handleEvent(event);
};
