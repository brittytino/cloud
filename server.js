'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  ScanCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand
} = require('@aws-sdk/lib-dynamodb');

const app = express();
const PORT = Number(process.env.PORT || 8080);
const BOOKS_TABLE = process.env.BOOKS_TABLE || 'BookstoreBooks';
const ORDERS_TABLE = process.env.ORDERS_TABLE || 'BookstoreOrders';
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-south-1';

const dynamo = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function cleanString(value, max = 160) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function validBook(body) {
  const title = cleanString(body.title);
  const author = cleanString(body.author);
  const price = Number(body.price);
  const stock = Number(body.stock);
  if (!title || !author) return { error: 'Title and author are required.' };
  if (!Number.isFinite(price) || price < 0) return { error: 'Price must be a valid non-negative number.' };
  if (!Number.isInteger(stock) || stock < 0) return { error: 'Stock must be a non-negative whole number.' };
  return { value: { title, author, price, stock } };
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'aws-lightweight-bookstore' });
});

app.get('/api/books', asyncRoute(async (req, res) => {
  const result = await dynamo.send(new ScanCommand({ TableName: BOOKS_TABLE }));
  const books = (result.Items || []).sort((a, b) => a.title.localeCompare(b.title));
  res.json(books);
}));

app.post('/api/books', asyncRoute(async (req, res) => {
  const parsed = validBook(req.body || {});
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const now = new Date().toISOString();
  const book = { id: crypto.randomUUID(), ...parsed.value, createdAt: now, updatedAt: now };
  await dynamo.send(new PutCommand({ TableName: BOOKS_TABLE, Item: book }));
  res.status(201).json(book);
}));

app.get('/api/books/:id', asyncRoute(async (req, res) => {
  const result = await dynamo.send(new GetCommand({
    TableName: BOOKS_TABLE,
    Key: { id: req.params.id }
  }));
  if (!result.Item) return res.status(404).json({ error: 'Book not found.' });
  res.json(result.Item);
}));

app.put('/api/books/:id', asyncRoute(async (req, res) => {
  const parsed = validBook(req.body || {});
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const existing = await dynamo.send(new GetCommand({
    TableName: BOOKS_TABLE,
    Key: { id: req.params.id }
  }));
  if (!existing.Item) return res.status(404).json({ error: 'Book not found.' });

  const updated = {
    ...existing.Item,
    ...parsed.value,
    updatedAt: new Date().toISOString()
  };
  await dynamo.send(new PutCommand({ TableName: BOOKS_TABLE, Item: updated }));
  res.json(updated);
}));

app.delete('/api/books/:id', asyncRoute(async (req, res) => {
  const existing = await dynamo.send(new GetCommand({
    TableName: BOOKS_TABLE,
    Key: { id: req.params.id }
  }));
  if (!existing.Item) return res.status(404).json({ error: 'Book not found.' });
  await dynamo.send(new DeleteCommand({
    TableName: BOOKS_TABLE,
    Key: { id: req.params.id }
  }));
  res.status(204).end();
}));

app.get('/api/orders', asyncRoute(async (req, res) => {
  const result = await dynamo.send(new ScanCommand({ TableName: ORDERS_TABLE }));
  const orders = (result.Items || []).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json(orders);
}));

app.post('/api/orders', asyncRoute(async (req, res) => {
  const customerName = cleanString(req.body?.customerName, 120);
  const customerEmail = cleanString(req.body?.customerEmail, 180);
  const bookId = cleanString(req.body?.bookId, 80);
  const quantity = Number(req.body?.quantity);

  if (!customerName || !customerEmail || !bookId) {
    return res.status(400).json({ error: 'Customer name, email, and book are required.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
    return res.status(400).json({ error: 'Quantity must be a whole number from 1 to 100.' });
  }

  const bookResult = await dynamo.send(new GetCommand({
    TableName: BOOKS_TABLE,
    Key: { id: bookId }
  }));
  const book = bookResult.Item;
  if (!book) return res.status(404).json({ error: 'Selected book was not found.' });
  if (book.stock < quantity) return res.status(400).json({ error: 'Not enough stock for this order.' });

  const now = new Date().toISOString();
  const order = {
    id: crypto.randomUUID(),
    customerName,
    customerEmail,
    bookId: book.id,
    bookTitle: book.title,
    quantity,
    unitPrice: book.price,
    total: Number((book.price * quantity).toFixed(2)),
    status: 'Received',
    createdAt: now
  };

  // Keep this lab example simple. For production, use a DynamoDB transaction
  // to create the order and decrement stock atomically.
  await dynamo.send(new PutCommand({ TableName: ORDERS_TABLE, Item: order }));
  await dynamo.send(new UpdateCommand({
    TableName: BOOKS_TABLE,
    Key: { id: book.id },
    UpdateExpression: 'SET #stock = #stock - :quantity, updatedAt = :updatedAt',
    ConditionExpression: '#stock >= :quantity',
    ExpressionAttributeNames: { '#stock': 'stock' },
    ExpressionAttributeValues: { ':quantity': quantity, ':updatedAt': now }
  }));
  res.status(201).json(order);
}));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'API endpoint not found.' });
  res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('Request failed:', err.name || 'Error', err.message || err);
  if (res.headersSent) return next(err);
  const status = err.name === 'ConditionalCheckFailedException' ? 409 : 500;
  res.status(status).json({
    error: status === 409
      ? 'Stock changed while placing the order. Refresh the page and try again.'
      : 'Something went wrong. Check the application logs for details.'
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Bookstore listening on port ${PORT}; region=${REGION}; books=${BOOKS_TABLE}; orders=${ORDERS_TABLE}`);
});
