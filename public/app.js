'use strict';

const $ = (selector) => document.querySelector(selector);
const state = { books: [], orders: [] };
const currency = (value) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(value || 0));

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function showNotice(message, isError = false) {
  const notice = $('#notice');
  notice.textContent = message;
  notice.classList.toggle('error', isError);
  notice.hidden = false;
  window.clearTimeout(showNotice.timer);
  showNotice.timer = window.setTimeout(() => { notice.hidden = true; }, 5000);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function renderBooks() {
  const term = $('#search').value.trim().toLowerCase();
  const books = state.books.filter((book) => `${book.title} ${book.author}`.toLowerCase().includes(term));
  $('#book-count').textContent = state.books.length;
  $('#stock-count').textContent = state.books.reduce((sum, book) => sum + Number(book.stock || 0), 0);
  $('#book-results').textContent = `${books.length} ${books.length === 1 ? 'title' : 'titles'}`;

  if (!books.length) {
    $('#books').innerHTML = `<div class="empty-state">${term ? 'No books match your search.' : 'Your bookshelf is empty. Add the first book to get started.'}</div>`;
  } else {
    $('#books').innerHTML = books.map((book) => `
      <article class="book-card">
        <div class="book-top"><div class="book-cover" aria-hidden="true">${escapeHtml(book.title.slice(0, 1).toUpperCase())}</div>
          <span class="stock-pill ${book.stock < 1 ? 'out' : ''}">${book.stock < 1 ? 'Out of stock' : `${book.stock} in stock`}</span></div>
        <h3>${escapeHtml(book.title)}</h3><p class="book-author">by ${escapeHtml(book.author)}</p>
        <div class="book-bottom"><span class="price">${currency(book.price)}</span>
          <div class="card-actions"><button class="small-button" data-edit="${escapeHtml(book.id)}" type="button">Edit</button><button class="small-button delete" data-delete="${escapeHtml(book.id)}" type="button">Delete</button></div>
        </div>
      </article>`).join('');
  }

  const available = state.books.filter((book) => book.stock > 0);
  $('#order-book').innerHTML = '<option value="">Select a book</option>' + available.map((book) =>
    `<option value="${escapeHtml(book.id)}">${escapeHtml(book.title)} — ${currency(book.price)} (${book.stock} available)</option>`
  ).join('');
}

function renderOrders() {
  $('#order-count').textContent = state.orders.length;
  if (!state.orders.length) {
    $('#orders-body').innerHTML = '<tr><td colspan="6" class="table-empty">No orders yet. New orders will appear here.</td></tr>';
    return;
  }
  $('#orders-body').innerHTML = state.orders.map((order) => `
    <tr><td class="order-id">#${escapeHtml(order.id.slice(0, 8).toUpperCase())}</td>
    <td>${escapeHtml(order.customerName)}<br><span class="muted">${escapeHtml(order.customerEmail)}</span></td>
    <td>${escapeHtml(order.bookTitle)}</td><td>${Number(order.quantity)}</td>
    <td>${currency(order.total)}</td><td><span class="order-status">${escapeHtml(order.status)}</span></td></tr>
  `).join('');
}

async function loadBooks() {
  state.books = await api('/api/books');
  renderBooks();
}

async function loadOrders() {
  state.orders = await api('/api/orders');
  renderOrders();
}

async function refreshAll() {
  try {
    await Promise.all([loadBooks(), loadOrders()]);
  } catch (error) {
    showNotice(`${error.message} Confirm the DynamoDB tables and AWS permissions are configured.`, true);
  }
}

function openBookForm(book = null) {
  $('#book-form').reset();
  $('#book-id').value = book?.id || '';
  $('#title').value = book?.title || '';
  $('#author').value = book?.author || '';
  $('#price').value = book?.price ?? '';
  $('#stock').value = book?.stock ?? '';
  $('#book-form-title').textContent = book ? 'Edit book details' : 'Add a book';
  $('#save-book').textContent = book ? 'Save changes' : 'Save book';
  $('#book-form-panel').hidden = false;
  $('#book-form-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('#title').focus();
}

function closeBookForm() {
  $('#book-form-panel').hidden = true;
  $('#book-form').reset();
  $('#book-id').value = '';
}

$('#show-add').addEventListener('click', () => openBookForm());
$('#cancel-edit').addEventListener('click', closeBookForm);
$('#cancel-form').addEventListener('click', closeBookForm);
$('#search').addEventListener('input', renderBooks);
$('#refresh-orders').addEventListener('click', async () => {
  try { await loadOrders(); showNotice('Orders refreshed.'); }
  catch (error) { showNotice(error.message, true); }
});

$('#book-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = $('#book-id').value;
  const payload = {
    title: $('#title').value.trim(),
    author: $('#author').value.trim(),
    price: Number($('#price').value),
    stock: Number($('#stock').value)
  };
  try {
    await api(id ? `/api/books/${encodeURIComponent(id)}` : '/api/books', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(payload)
    });
    closeBookForm();
    await loadBooks();
    showNotice(id ? 'Book details updated.' : 'Book added to the collection.');
  } catch (error) { showNotice(error.message, true); }
});

$('#books').addEventListener('click', async (event) => {
  const editButton = event.target.closest('[data-edit]');
  const deleteButton = event.target.closest('[data-delete]');
  if (editButton) {
    const book = state.books.find((item) => item.id === editButton.dataset.edit);
    if (book) openBookForm(book);
  }
  if (deleteButton) {
    const book = state.books.find((item) => item.id === deleteButton.dataset.delete);
    if (!book || !window.confirm(`Delete "${book.title}" from the inventory?`)) return;
    try {
      await api(`/api/books/${encodeURIComponent(book.id)}`, { method: 'DELETE' });
      await loadBooks();
      showNotice('Book deleted.');
    } catch (error) { showNotice(error.message, true); }
  }
});

$('#order-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = {
    customerName: $('#customer-name').value.trim(),
    customerEmail: $('#customer-email').value.trim(),
    bookId: $('#order-book').value,
    quantity: Number($('#quantity').value)
  };
  try {
    await api('/api/orders', { method: 'POST', body: JSON.stringify(payload) });
    $('#order-form').reset();
    $('#quantity').value = 1;
    await Promise.all([loadBooks(), loadOrders()]);
    showNotice('Order placed successfully. Inventory has been updated.');
  } catch (error) { showNotice(error.message, true); }
});

refreshAll();
