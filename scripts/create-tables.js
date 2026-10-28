'use strict';

// Run once with AWS credentials configured for your account:
// node scripts/create-tables.js
const {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
  waitUntilTableExists
} = require('@aws-sdk/client-dynamodb');

const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-south-1';
const client = new DynamoDBClient({ region });

const tables = [
  { TableName: process.env.BOOKS_TABLE || 'BookstoreBooks', AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }], KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }] },
  { TableName: process.env.ORDERS_TABLE || 'BookstoreOrders', AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }], KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }] }
];

async function ensureTable(table) {
  try {
    await client.send(new DescribeTableCommand({ TableName: table.TableName }));
    console.log(`Already exists: ${table.TableName}`);
  } catch (error) {
    if (error.name !== 'ResourceNotFoundException') throw error;
    await client.send(new CreateTableCommand({
      ...table,
      BillingMode: 'PAY_PER_REQUEST'
    }));
    console.log(`Creating: ${table.TableName}`);
  }
  await waitUntilTableExists({ client, maxWaitTime: 120 }, { TableName: table.TableName });
  console.log(`Ready: ${table.TableName}`);
}

(async () => {
  try {
    for (const table of tables) await ensureTable(table);
    console.log('DynamoDB setup complete.');
  } catch (error) {
    console.error('Could not create tables:', error.message);
    process.exitCode = 1;
  } finally {
    client.destroy();
  }
})();
