# Page & Pine — Online Bookstore

A lightweight full-stack bookstore for a Cloud Computing Laboratory exercise. It demonstrates CRUD operations, customer order management, GitHub source control, Amazon DynamoDB, and AWS Elastic Beanstalk deployment.

## Stack

- Frontend: HTML, CSS, vanilla JavaScript
- Backend: Node.js and Express
- Database: Amazon DynamoDB (on-demand billing)
- Hosting: AWS Elastic Beanstalk
- Source control: GitHub

## Features

- List and search books
- Add, edit, and delete books
- Place customer orders
- View recent orders
- Reduce available inventory after an order
- Basic server-side input validation
- Health endpoint: `/api/health`

## 1. Install dependencies

Use Node.js 20 or newer.

```bash
npm install
```

## 2. Configure AWS credentials for local setup

For local development, configure the AWS CLI with a dedicated IAM identity. Do not paste access keys into source files or commit them to GitHub.

```bash
aws configure
aws sts get-caller-identity
```

Choose `ap-south-1` (Mumbai) when prompted, or use another region consistently.

## 3. Create DynamoDB tables

The identity used locally needs permission to create and describe DynamoDB tables.

```bash
node scripts/create-tables.js
```

This creates `BookstoreBooks` and `BookstoreOrders` using on-demand billing. AWS usage may incur charges.

## 4. Run locally

```bash
npm start
```

Open `http://localhost:8080`. Verify the API health endpoint at `http://localhost:8080/api/health`.

## 5. Push to GitHub

Create an empty GitHub repository named `aws-online-bookstore`. From the project directory:

```bash
git init
git add .
git commit -m "Build lightweight AWS bookstore"
git branch -M main
git remote add origin https://github.com/YOUR_GITHUB_USERNAME/aws-online-bookstore.git
git push -u origin main
```

Replace `YOUR_GITHUB_USERNAME` with your GitHub username. Never commit AWS credentials.

## 6. Deploy to AWS Elastic Beanstalk

### A. Create an Elastic Beanstalk application

In the AWS Console, open Elastic Beanstalk and create an application named `aws-online-bookstore`. Create an environment using the **Node.js** platform. Use a supported Node.js 20+ platform version if available.

For a classroom demo, select a single-instance environment if the console offers that option. Avoid a load-balanced environment unless required; it can cost more.

### B. Give the environment permission to access DynamoDB

Create or select an EC2 instance profile role for the environment. Attach a narrowly scoped policy that allows these actions only on the two tables in your chosen region:

- `dynamodb:Scan`
- `dynamodb:GetItem`
- `dynamodb:PutItem`
- `dynamodb:UpdateItem`
- `dynamodb:DeleteItem`

Resource ARNs:
- `arn:aws:dynamodb:ap-south-1:YOUR_ACCOUNT_ID:table/BookstoreBooks`
- `arn:aws:dynamodb:ap-south-1:YOUR_ACCOUNT_ID:table/BookstoreOrders`

Replace `YOUR_ACCOUNT_ID` and the region if needed. Attach this policy to the **EC2 instance role used by the environment**, not to a user or the application code. The role used to create tables locally separately needs table-creation permissions.

### C. Set environment properties

In the Elastic Beanstalk environment configuration, set:

- `AWS_REGION` = `ap-south-1`
- `BOOKS_TABLE` = `BookstoreBooks`
- `ORDERS_TABLE` = `BookstoreOrders`

Elastic Beanstalk sets `PORT` for the Node.js process when needed; the app also defaults to 8080 for local use.

### D. Upload the application

From the project root, create a ZIP containing the project files (not the parent folder and not `node_modules`). Upload it as the application version in Elastic Beanstalk.

For example, on PowerShell from the project root:

```powershell
Compress-Archive -Path server.js,package.json,package-lock.json,Procfile,public,scripts,.ebextensions -DestinationPath bookstore-deploy.zip -Force
```

If `package-lock.json` does not exist yet, omit it from the command. Do not include `.env` or credentials. Elastic Beanstalk installs dependencies during deployment.

### E. Test deployment

Open the environment URL provided by Elastic Beanstalk and check:

- The page loads over HTTP/HTTPS as configured.
- `/api/health` returns `{"status":"ok","service":"aws-lightweight-bookstore"}`.
- Add, edit, and delete a book.
- Place an order and confirm that the inventory decreases.
- Refresh the page and verify data persists.

## Important limitations for this lab

- This is an educational demo, not a production commerce system.
- Order creation and stock decrement are separate writes, not an atomic transaction. Production code should use `TransactWriteItems` with conditional stock checks.
- The app currently uses DynamoDB `Scan` for small demo datasets. A production system should use access patterns and indexes designed for its expected data volume.
- Authentication, authorization, CSRF protection, rate limiting, and payment processing are not included. Do not use real customer data or expose this demo as a public production store.
- Delete unused AWS resources after the lab to avoid ongoing charges.
