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

import pino from 'pino';
const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    timestamp: pino.stdTimeFunctions.isoTime, // ISO 8601 for easy reading
    formatters: {
        level(label) {
            return { level: label };
        },
    }
})

// Constant parameters
const MAX_BATCH_SIZE: number = Number(process.env.DYNAMO_DB_BATCH_SIZE) || 25;
const MAX_RETRIES: number = Number(process.env.DYNAMO_DB_BATCH_MAX_RETRIES) || 5;
const BASE_DELAY_MS: number = Number(process.env.DYNAMO_DB_BATCH_BASE_DELAY_MS) || 200;

class CSVToDynamoImporter {

    // Create instances for DynamoDB and S3
    private _s3Client = new S3Client({});
    private _ddbClient = new DynamoDBClient({});

    // Dynamo DB - Fields
    private _tableName = process.env.DYNAMO_TABLE_NAME!;
    private _partitionKeyName: string = "";
    private _partitionKeyType: "S" | "N" = "S";

    constructor() {
        if (!this._tableName) {
            throw new Error("Environment variable DYNAMO_TABLE_NAME is not set.");
        }
    }

    /**
     * @description Handles an incoming S3 event triggered by an object upload and processes the CSV file.
     * 
     * This method performs the end-to-end flow of:
     * - Extracting the bucket and object key from the S3 event.
     * - Loading DynamoDB partition key metadata dynamically.
     * - Downloading the CSV file content from S3.
     * - Parsing the CSV into rows using headers as keys.
     * - Writing the parsed data to DynamoDB in batches.
     * 
     * Assumes that only one S3 record is present in the event (typically true for single-object triggers).
     * 
     * @param {S3Event} event - The S3 event payload from the Lambda trigger.
     * @returns {Promise<void>} A promise that resolves when processing is complete.
     * 
     * @throws {Error} If any step in the process fails (e.g., missing partition key, invalid CSV, S3 access error).
     */
    async handleEvent(event: S3Event): Promise<void> {

        logger.info({ msg: "Lambda input event", event });

        const record = event.Records[0];
        const bucket = record.s3.bucket.name;
        const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

        logger.info({ msg: "Start processing CSV file", bucket, key });

        await this.loadPartitionKeyMetadata();

        const csvContent = await this.getCSVFileContent(bucket, key);

        logger.info({ msg: "Retrieved CSV content as string", csvContent });

        const rows = this.parseCSV(csvContent);

        logger.debug({ msg: "Number of rows to upload", count: rows.length });

        await this.processRows(rows);
    }

    /**
     * @description Retrieves and stores the partition key metadata from the DynamoDB table.
     * 
     * This method sends a DescribeTableCommand to fetch the table's schema and 
     * identifies the partition key (HASH key) and its data type.
     * 
     * It sets the internal class properties `partitionKeyName` and `partitionKeyType`
     * based on the table definition, allowing dynamic support for different table schemas.
     * 
     * @throws {Error} If the partition key or its attribute type cannot be determined.
     */
    private async loadPartitionKeyMetadata(): Promise<void> {
        const response = await this._ddbClient.send(new DescribeTableCommand({
            TableName: this._tableName
        }));

        const keySchema = response.Table?.KeySchema?.find(k => k.KeyType === "HASH");

        const attrDef = response.Table?.AttributeDefinitions?.find(
            a => a.AttributeName === keySchema?.AttributeName
        );

        if (!keySchema || !attrDef) {
            throw new Error("Unable to determine partition key schema from DynamoDB table.");
        }

        this._partitionKeyName = keySchema.AttributeName!;
        this._partitionKeyType = attrDef.AttributeType as "S" | "N";

        logger.info({
            msg: "Loaded partition key metadata",
            partitionKeyName: this._partitionKeyName,
            partitionKeyType: this._partitionKeyType
        });
    }

    /**
     * @description Retrieves the contents of a CSV file stored in an S3 bucket as a UTF-8 string.
     *
     * This method sends a `GetObjectCommand` to the S3 service and expects the object body
     * to support the `transformToString()` method (available in AWS SDK v3 for Node.js).
     * It reads the full file content into memory as a string.
     * 
     * @param {string} bucket - The name of the S3 bucket containing the file.
     * @param {string} key - The key (path) to the file within the S3 bucket.
     * @returns {Promise<string>} A promise that resolves to the CSV file content as a string.
     * 
     * @throws {Error} If the S3 object response body is missing or not compatible with `transformToString`.
     */
    private async getCSVFileContent(bucket: string, key: string): Promise<string> {
        const response = await this._s3Client.send(new GetObjectCommand({
            Bucket: bucket,
            Key: key
        }));

        if (!response.Body || !("transformToString" in response.Body)) {
            throw new Error("S3 response body missing or not a valid stream.");
        }

        return await response.Body.transformToString();
    }

    /**
     * @description Parses a CSV string into an array of objects using the header row as keys.
     * 
     * This method uses the `csv-parse/sync` parser to convert the raw CSV content
     * into a structured array of records. Each object in the array represents a row,
     * with keys derived from the header row and values as strings.
     * 
     * The parser handles:
     * - Trimming whitespace from values
     * - Skipping empty lines
     * - Quoted fields with commas or newlines
     * 
     * @param {string} content - The raw CSV content as a UTF-8 string.
     * @returns {Record<string, string>[]} An array of objects representing each row in the CSV.
     * 
     * @throws {Error} If the CSV parsing fails.
     */
    private parseCSV(content: string): Record<string, string>[] {
        try {
            return parse(content, {
                columns: true,
                skip_empty_lines: true,
                trim: true,
            }) as Record<string, string>[];
        } catch (error) {
            console.error("[ERROR] CSV parsing failed: ", error);
            throw new Error("Failed to parse CSV content.");
        }
    }

    /**
     * @description Processes an array of CSV row objects and writes them to DynamoDB in batches.
     * 
     * This method:
     * - Converts each CSV row into a DynamoDB item using `mapRowToDynamoItem`.
     * - Groups items into batches of up to 25 (the DynamoDB `BatchWriteItem` limit).
     * - Sends each batch using `batchWriteItems`, and handles any remaining items at the end.
     * 
     * @param {Record<string, string>[]} rows - An array of parsed CSV rows where each object represents a row with string values.
     * @returns {Promise<void>} A promise that resolves when all rows have been successfully written to DynamoDB.
     */
    private async processRows(rows: Record<string, string>[]): Promise<void> {
        let batch: WriteRequest[] = [];

        for (const row of rows) {
            const formattedItem = this.mapRowToDynamoItem(row);
            batch.push({ PutRequest: { Item: formattedItem } });

            if (batch.length === MAX_BATCH_SIZE) {
                await this.batchWriteItems(batch);
                batch = [];
            }
        }

        if (batch.length > 0) {
            await this.batchWriteItems(batch);
        }
    }

    /**
     * @description Converts a single CSV row into a DynamoDB item formatted as a map of attribute values.
     * 
     * This method takes a key-value pair object (representing a parsed CSV row)
     * and transforms it into a DynamoDB-compatible item using the correct `AttributeValue` types.
     * 
     * The partition key is handled dynamically based on its type (`S` for string or `N` for number),
     * while all other attributes are stored as strings (`S`).
     * 
     * Empty or undefined values are skipped.
     * 
     * @param {Record<string, string>} row - A parsed CSV row, with keys as column headers.
     * @returns {Record<string, AttributeValue>} A DynamoDB item suitable for Put or BatchWrite operations.
     */
    private mapRowToDynamoItem(row: Record<string, string>): Record<string, AttributeValue> {
        const item: Record<string, AttributeValue> = {};

        for (const [key, value] of Object.entries(row)) {
            if (!value) continue;
            if (key === this._partitionKeyName) {
                item[key] = this._partitionKeyType === "N" && !isNaN(Number(value))
                    ? { N: String(Number(value)) }
                    : { S: value };
            } else {
                item[key] = { S: value };
            }
        }

        return item;
    }

    /**
     * @description Writes an array of items to DynamoDB in a single batch operation with retry logic.
     * 
     * This method sends a `BatchWriteItemCommand` to insert multiple items into a DynamoDB table.
     * If any items are returned as unprocessed, it retries them using exponential backoff
     * up to a maximum number of attempts.
     * 
     * @param {WriteRequest[]} writeRequests - An array of DynamoDB write requests (Put operations).
     * @returns {Promise<void>} A promise that resolves when all items have been successfully written or retries are exhausted.
     * 
     * @throws {Error} If unprocessed items remain after the maximum retry attempts.
     */
    private async batchWriteItems(writeRequests: WriteRequest[]): Promise<void> {
        let unprocessed = [...writeRequests];
        let attempt = 0;

        while (unprocessed.length > 0 && attempt < MAX_RETRIES) {
            const response = await this._ddbClient.send(new BatchWriteItemCommand({
                RequestItems: {
                    [this._tableName]: unprocessed,
                },
            }));

            unprocessed = response.UnprocessedItems?.[this._tableName] ?? [];

            if (unprocessed.length > 0) {
                attempt++;
                const delay = Math.pow(2, attempt) * BASE_DELAY_MS;

                logger.warn({ msg: 'Retrying unprocessed items', retryCount: attempt, delay });
                await new Promise(res => setTimeout(res, delay));
            }
        }

        if (unprocessed.length > 0) {
            throw new Error("Failed to process ${unprocessed.length} items after ${MAX_RETRIES} retries.");
        }
    }

}

export const handler = async (event: S3Event) => {
    try {
        const importer = new CSVToDynamoImporter();
        await importer.handleEvent(event);
    } catch (e) {
        logger.error({ msg: 'Error while executing the Lambda function', error: e, event });
        throw e;
    }
};
