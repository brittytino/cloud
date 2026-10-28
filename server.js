'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

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
const PORT = Number(process.env.PORT || 6969);
const BOOKS_TABLE = process.env.BOOKS_TABLE || 'BookstoreBooks';
const ORDERS_TABLE = process.env.ORDERS_TABLE || 'BookstoreOrders';
const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-south-1';

// Local demo data persists in this file across server restarts.
const DATA_FILE = path.join(__dirname, 'local-data.json');

let localData = { books: [], orders: [] };

try {
  if (fs.existsSync(DATA_FILE)) {
    localData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }
} catch (error) {
  console.error('Could not load local demo data:', error.message);
}

function saveLocalData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(localData, null, 2));
}

const dynamo = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } }
);

let useLocalMode = process.env.DEMO_MODE === 'true';

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

  if (!title || !author) {
    return { error: 'Title and author are required.' };
  }

  if (!Number.isFinite(price) || price < 0) {
    return { error: 'Price must be a valid non-negative number.' };
  }

  if (!Number.isInteger(stock) || stock < 0) {
    return { error: 'Stock must be a non-negative whole number.' };
  }

  return { value: { title, author, price, stock } };
}

function asyncRoute(handler) {
  return (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);
}

function sortBooks() {
  return [...localData.books].sort((a, b) =>
    a.title.localeCompare(b.title)
  );
}

function findBook(id) {
  return localData.books.find(book => book.id === id);
}

function makeId() {
  return crypto.randomUUID();
}

// Try DynamoDB first. If credentials are missing, switch to local mode.
async function dynamoRequest(operation) {
  if (useLocalMode) return null;

  try {
    return await operation();
  } catch (error) {
    const credentialError =
      error.name === 'CredentialsProviderError' ||
      error.name === 'CredentialProviderError' ||
      error.name === 'NoCredentials';

    if (credentialError) {
      useLocalMode = true;
      console.warn('AWS credentials unavailable. Switching to LOCAL DEMO MODE.');
      return null;
    }

    throw error;
  }
}

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'aws-lightweight-bookstore',
    mode: useLocalMode ? 'local-demo' : 'aws-dynamodb'
  });
});

app.get('/api/books', asyncRoute(async (req, res) => {
  const result = await dynamoRequest(() =>
    dynamo.send(new ScanCommand({ TableName: BOOKS_TABLE }))
  );

  if (result) {
    return res.json((result.Items || []).sort((a, b) =>
      a.title.localeCompare(b.title)
    ));
  }

  res.json(sortBooks());
}));

app.post('/api/books', asyncRoute(async (req, res) => {
  const parsed = validBook(req.body || {});
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const now = new Date().toISOString();
  const book = {
    id: makeId(),
    ...parsed.value,
    createdAt: now,
    updatedAt: now
  };

  const result = await dynamoRequest(() =>
    dynamo.send(new PutCommand({
      TableName: BOOKS_TABLE,
      Item: book
    }))
  );

  if (!result) {
    localData.books.push(book);
    saveLocalData();
  }

  res.status(201).json(book);
}));

app.get('/api/books/:id', asyncRoute(async (req, res) => {
  const result = await dynamoRequest(() =>
    dynamo.send(new GetCommand({
      TableName: BOOKS_TABLE,
      Key: { id: req.params.id }
    }))
  );

  const book = result ? result.Item : findBook(req.params.id);

  if (!book) return res.status(404).json({ error: 'Book not found.' });

  res.json(book);
}));

app.put('/api/books/:id', asyncRoute(async (req, res) => {
  const parsed = validBook(req.body || {});
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  const existingResult = await dynamoRequest(() =>
    dynamo.send(new GetCommand({
      TableName: BOOKS_TABLE,
      Key: { id: req.params.id }
    }))
  );

  const existing = existingResult
    ? existingResult.Item
    : findBook(req.params.id);

  if (!existing) return res.status(404).json({ error: 'Book not found.' });

  const updated = {
    ...existing,
    ...parsed.value,
    updatedAt: new Date().toISOString()
  };

  const result = await dynamoRequest(() =>
    dynamo.send(new PutCommand({
      TableName: BOOKS_TABLE,
      Item: updated
    }))
  );

  if (!result) {
    localData.books = localData.books.map(book =>
      book.id === req.params.id ? updated : book
    );
    saveLocalData();
  }

  res.json(updated);
}));

app.delete('/api/books/:id', asyncRoute(async (req, res) => {
  const existingResult = await dynamoRequest(() =>
    dynamo.send(new GetCommand({
      TableName: BOOKS_TABLE,
      Key: { id: req.params.id }
    }))
  );

  const existing = existingResult
    ? existingResult.Item
    : findBook(req.params.id);

  if (!existing) return res.status(404).json({ error: 'Book not found.' });

  const result = await dynamoRequest(() =>
    dynamo.send(new DeleteCommand({
      TableName: BOOKS_TABLE,
      Key: { id: req.params.id }
    }))
  );

  if (!result) {
    localData.books = localData.books.filter(book =>
      book.id !== req.params.id
    );
    saveLocalData();
  }

  res.status(204).end();
}));

app.get('/api/orders', asyncRoute(async (req, res) => {
  const result = await dynamoRequest(() =>
    dynamo.send(new ScanCommand({ TableName: ORDERS_TABLE }))
  );

  const orders = result
    ? (result.Items || [])
    : localData.orders;

  res.json([...orders].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  ));
}));

app.post('/api/orders', asyncRoute(async (req, res) => {
  const customerName = cleanString(req.body?.customerName, 120);
  const customerEmail = cleanString(req.body?.customerEmail, 180);
  const bookId = cleanString(req.body?.bookId, 80);
  const quantity = Number(req.body?.quantity);

  if (!customerName || !customerEmail || !bookId) {
    return res.status(400).json({
      error: 'Customer name, email, and book are required.'
    });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
    return res.status(400).json({
      error: 'Quantity must be a whole number from 1 to 100.'
    });
  }

  const bookResult = await dynamoRequest(() =>
    dynamo.send(new GetCommand({
      TableName: BOOKS_TABLE,
      Key: { id: bookId }
    }))
  );

  const book = bookResult ? bookResult.Item : findBook(bookId);

  if (!book) {
    return res.status(404).json({ error: 'Selected book was not found.' });
  }

  if (book.stock < quantity) {
    return res.status(400).json({ error: 'Not enough stock for this order.' });
  }

  const now = new Date().toISOString();

  const order = {
    id: makeId(),
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

  if (useLocalMode) {
    localData.orders.push(order);

    localData.books = localData.books.map(item =>
      item.id === book.id
        ? { ...item, stock: item.stock - quantity, updatedAt: now }
        : item
    );

    saveLocalData();
  } else {
    await dynamo.send(new PutCommand({
      TableName: ORDERS_TABLE,
      Item: order
    }));

    await dynamo.send(new UpdateCommand({
      TableName: BOOKS_TABLE,
      Key: { id: book.id },
      UpdateExpression: 'SET #stock = #stock - :quantity, updatedAt = :updatedAt',
      ConditionExpression: '#stock >= :quantity',
      ExpressionAttributeNames: { '#stock': 'stock' },
      ExpressionAttributeValues: {
        ':quantity': quantity,
        ':updatedAt': now
      }
    }));
  }

  res.status(201).json(order);
}));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API endpoint not found.' });
  }

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
  console.log(`Bookstore listening on port ${PORT}; region=${REGION}`);
  console.log(`Mode: ${useLocalMode ? 'LOCAL DEMO' : 'AWS DynamoDB (fallback to local on missing credentials)'}`);
});