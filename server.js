'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();

const PORT = Number(process.env.PORT || 6969);
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is not configured.');
  process.exit(1);
}

// Neon PostgreSQL connection pool.
// Set DATABASE_URL in Render Environment Variables.
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err.message);
});

app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --------------------------------------------------
// Helpers
// --------------------------------------------------

function cleanString(value, maxLength = 160) {
  return typeof value === 'string'
    ? value.trim().slice(0, maxLength)
    : '';
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

  return {
    value: {
      title,
      author,
      price: Number(price.toFixed(2)),
      stock
    }
  };
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

// Convert PostgreSQL snake_case fields into the camelCase JSON
// properties expected by the existing frontend.

function mapBook(row) {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    price: Number(row.price),
    stock: row.stock,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapOrder(row) {
  return {
    id: row.id,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    bookId: row.book_id,
    bookTitle: row.book_title,
    quantity: row.quantity,
    unitPrice: Number(row.unit_price),
    total: Number(row.total),
    status: row.status,
    createdAt: row.created_at
  };
}

// --------------------------------------------------
// Health check
// --------------------------------------------------

app.get('/api/health', asyncRoute(async (req, res) => {
  await pool.query('SELECT 1');

  res.json({
    status: 'ok',
    service: 'aws-lightweight-bookstore',
    database: 'connected'
  });
}));

// --------------------------------------------------
// BOOKS: READ ALL
// GET /api/books
// --------------------------------------------------

app.get('/api/books', asyncRoute(async (req, res) => {
  const result = await pool.query(`
    SELECT
      id,
      title,
      author,
      price,
      stock,
      created_at,
      updated_at
    FROM books
    ORDER BY title ASC
  `);

  res.json(result.rows.map(mapBook));
}));

// --------------------------------------------------
// BOOKS: CREATE
// POST /api/books
// --------------------------------------------------

app.post('/api/books', asyncRoute(async (req, res) => {
  const parsed = validBook(req.body || {});

  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }

  const { title, author, price, stock } = parsed.value;
  const id = crypto.randomUUID();

  const result = await pool.query(
    `
      INSERT INTO books (
        id,
        title,
        author,
        price,
        stock
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING
        id,
        title,
        author,
        price,
        stock,
        created_at,
        updated_at
    `,
    [id, title, author, price, stock]
  );

  res.status(201).json(mapBook(result.rows[0]));
}));

// --------------------------------------------------
// BOOKS: READ ONE
// GET /api/books/:id
// --------------------------------------------------

app.get('/api/books/:id', asyncRoute(async (req, res) => {
  const result = await pool.query(
    `
      SELECT
        id,
        title,
        author,
        price,
        stock,
        created_at,
        updated_at
      FROM books
      WHERE id = $1
    `,
    [req.params.id]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'Book not found.' });
  }

  res.json(mapBook(result.rows[0]));
}));

// --------------------------------------------------
// BOOKS: UPDATE
// PUT /api/books/:id
// --------------------------------------------------

app.put('/api/books/:id', asyncRoute(async (req, res) => {
  const parsed = validBook(req.body || {});

  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }

  const { title, author, price, stock } = parsed.value;

  const result = await pool.query(
    `
      UPDATE books
      SET
        title = $1,
        author = $2,
        price = $3,
        stock = $4,
        updated_at = NOW()
      WHERE id = $5
      RETURNING
        id,
        title,
        author,
        price,
        stock,
        created_at,
        updated_at
    `,
    [title, author, price, stock, req.params.id]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'Book not found.' });
  }

  res.json(mapBook(result.rows[0]));
}));

// --------------------------------------------------
// BOOKS: DELETE
// DELETE /api/books/:id
// --------------------------------------------------

app.delete('/api/books/:id', asyncRoute(async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Prevent deleting a book that has order history.
    const orderCheck = await client.query(
      'SELECT 1 FROM orders WHERE book_id = $1 LIMIT 1',
      [req.params.id]
    );

    if (orderCheck.rowCount > 0) {
      await client.query('ROLLBACK');

      return res.status(409).json({
        error: 'This book has order history and cannot be deleted.'
      });
    }

    const result = await client.query(
      'DELETE FROM books WHERE id = $1 RETURNING id',
      [req.params.id]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');

      return res.status(404).json({ error: 'Book not found.' });
    }

    await client.query('COMMIT');

    res.status(204).end();
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { });
    throw err;
  } finally {
    client.release();
  }
}));

// --------------------------------------------------
// ORDERS: READ ALL
// GET /api/orders
// --------------------------------------------------

app.get('/api/orders', asyncRoute(async (req, res) => {
  const result = await pool.query(`
    SELECT
      id,
      customer_name,
      customer_email,
      book_id,
      book_title,
      quantity,
      unit_price,
      total,
      status,
      created_at
    FROM orders
    ORDER BY created_at DESC
  `);

  res.json(result.rows.map(mapOrder));
}));

// --------------------------------------------------
// ORDERS: CREATE
// POST /api/orders
//
// Uses a PostgreSQL transaction to ensure the order
// and stock update succeed or fail together.
// --------------------------------------------------

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
    return res.status(400).json({
      error: 'Enter a valid email address.'
    });
  }

  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
    return res.status(400).json({
      error: 'Quantity must be a whole number from 1 to 100.'
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Lock the selected book so concurrent orders cannot
    // sell the same remaining stock.
    const bookResult = await client.query(
      `
        SELECT id, title, price, stock
        FROM books
        WHERE id = $1
        FOR UPDATE
      `,
      [bookId]
    );

    if (bookResult.rowCount === 0) {
      await client.query('ROLLBACK');

      return res.status(404).json({
        error: 'Selected book was not found.'
      });
    }

    const book = bookResult.rows[0];

    if (book.stock < quantity) {
      await client.query('ROLLBACK');

      return res.status(400).json({
        error: 'Not enough stock for this order.'
      });
    }

    const id = crypto.randomUUID();
    const total = Number(
      (Number(book.price) * quantity).toFixed(2)
    );

    const orderResult = await client.query(
      `
        INSERT INTO orders (
          id,
          customer_name,
          customer_email,
          book_id,
          book_title,
          quantity,
          unit_price,
          total,
          status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING
          id,
          customer_name,
          customer_email,
          book_id,
          book_title,
          quantity,
          unit_price,
          total,
          status,
          created_at
      `,
      [
        id,
        customerName,
        customerEmail,
        book.id,
        book.title,
        quantity,
        book.price,
        total,
        'Received'
      ]
    );

    await client.query(
      `
        UPDATE books
        SET
          stock = stock - $1,
          updated_at = NOW()
        WHERE id = $2
      `,
      [quantity, book.id]
    );

    await client.query('COMMIT');

    res.status(201).json(mapOrder(orderResult.rows[0]));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { });
    throw err;
  } finally {
    client.release();
  }
}));

// --------------------------------------------------
// 404 HANDLER
// --------------------------------------------------

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({
      error: 'API endpoint not found.'
    });
  }

  res.status(404).sendFile(
    path.join(__dirname, 'public', 'index.html')
  );
});

// --------------------------------------------------
// ERROR HANDLER
// --------------------------------------------------

app.use((err, req, res, next) => {
  console.error(
    'Request failed:',
    err.code || err.name || 'Error',
    err.message || err
  );

  if (res.headersSent) {
    return next(err);
  }

  // PostgreSQL foreign-key constraint violation.
  if (err.code === '23503') {
    return res.status(409).json({
      error: 'This operation conflicts with existing order records.'
    });
  }

  // PostgreSQL unique constraint violation.
  if (err.code === '23505') {
    return res.status(409).json({
      error: 'A record with this identifier already exists.'
    });
  }

  res.status(500).json({
    error: 'Something went wrong. Check the application logs for details.'
  });
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Bookstore listening on port ${PORT}`);
  console.log('Database: Neon PostgreSQL');
});

async function shutdown(signal) {
  console.log(`${signal} received. Shutting down...`);

  server.close(async () => {
    try {
      await pool.end();
      process.exit(0);
    } catch (err) {
      console.error('Error closing database pool:', err.message);
      process.exit(1);
    }
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));