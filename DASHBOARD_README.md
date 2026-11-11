# AWS Resource CRUD Dashboard

A simple, clean web-based interface for managing AWS accounts and resources directly from your local server. No browser plugins needed!

## What's New

We've created a full CRUD (Create, Read, Update, Delete) dashboard for your AWS account management. No more trying to redirect AWS console traffic through plugins - this is a self-contained solution running on your local Next.js server.

## Features

### 📊 Dashboard
- **Account Overview**: View all your AWS accounts in a clean card-based layout
- **Account Details**: Click any account to see detailed information and associated resources
- **Add New Accounts**: Create new accounts directly from the dashboard
- **Edit Accounts**: Update account details like name, email, and join method
- **Delete Accounts**: Remove accounts (with confirmation)

### 🔍 Resource Management
- **Auto-Discovery**: Automatically scans your local AWS resource directories
- **Resource Counts**: Shows how many resources of each type exist per region
- **Multi-Region Support**: Lists resources across all configured regions (eu-central-1, eu-west-1, etc.)
- **Resource Types**: Tracks KMS keys, S3 buckets, Lambda functions, RDS databases, CloudWatch metrics, ECR repositories, and SSM parameters

## Getting Started

### Running the Server

```bash
cd /Users/jacco/AdventOfCode2025/react/jpk-app
npm run dev
```

The server will start on `http://localhost:3001` (or the next available port if 3001 is busy).

### Accessing the Dashboard

1. **Home Page**: `http://localhost:3001/`
2. **Dashboard**: `http://localhost:3001/dashboard`
3. **New Account**: `http://localhost:3001/dashboard/accounts/new`
4. **Account Details**: `http://localhost:3001/dashboard/accounts/{accountId}`

## API Endpoints

All endpoints are fully functional and can be called programmatically:

### Accounts Management

#### List All Accounts
```bash
GET /api/accounts
```

Response:
```json
[
  {
    "id": "123456789012",
    "name": "Production",
    "email": "prod@example.com",
    "joinMethod": "CREATED",
    "joinedTimestamp": 1794257998383,
    "requestedTimestamp": 1794257998383
  }
]
```

#### Get Single Account
```bash
GET /api/accounts/{accountId}
```

#### Create Account
```bash
POST /api/accounts
Content-Type: application/json

{
  "id": "123456789012",
  "name": "Production",
  "email": "prod@example.com",
  "joinMethod": "CREATED",
  "joinedTimestamp": 1694257998383,
  "requestedTimestamp": 1694257998383
}
```

#### Update Account
```bash
PUT /api/accounts/{accountId}
Content-Type: application/json

{
  "name": "Updated Name",
  "email": "newemail@example.com",
  "joinMethod": "INVITED"
}
```

Fields like `id` and `joinedTimestamp` are immutable.

#### Delete Account
```bash
DELETE /api/accounts/{accountId}
```

### Resources Management

#### Get Resources for Account
```bash
GET /api/accounts/{accountId}/resources
```

Response:
```json
[
  {
    "type": "KMS",
    "region": "eu-central-1",
    "count": 3
  },
  {
    "type": "S3",
    "region": "eu-central-1",
    "count": 5
  }
]
```

## File Structure

```
src/
├── app/
│   ├── dashboard/
│   │   ├── page.tsx                 # Main dashboard
│   │   ├── dashboard.module.css     # Dashboard styles
│   │   └── accounts/
│   │       ├── accounts.module.css  # Account pages styles
│   │       ├── new/
│   │       │   └── page.tsx         # Create new account
│   │       └── [id]/
│   │           └── page.tsx         # Account details & edit
│   └── api/
│       ├── accounts/
│       │   ├── route.ts             # List & create accounts
│       │   ├── [id]/
│       │   │   └── route.ts         # Get, update, delete accounts
│       │   └── [id]/resources/
│       │       └── route.ts         # Get resources for account
│       └── ...other APIs...
├── layout.tsx                       # Root layout with navigation
├── layout.css                       # Navigation styles
└── page.tsx                         # Home page
```

## Data Storage

All account data is stored in `/db/accounts.json`. The file is automatically managed by the API routes - no manual editing needed (though you can if you want to).

```json
[
  {
    "id": "123456789012",
    "name": "Production",
    "email": "prod@example.com",
    "joinMethod": "CREATED",
    "joinedTimestamp": 1694257998383,
    "requestedTimestamp": 1694257998383,
    "completedTimestamp": 1694257998383
  }
]
```

## Resource Discovery

The dashboard automatically scans directories for AWS resources. It supports two structures:

**Current Structure (Your Setup)**:
```
db/
├── accounts.json
├── 390209512651/
│   ├── eu-central-1/
│   │   ├── ssm.json      ← Resource files directly in region
│   │   ├── kms.json
│   │   ├── s3.json
│   │   └── ...
│   └── eu-west-1/
│       └── ...
└── ...other accounts...
```

**Legacy Structure (Also Supported)**:
```
db/
├── accounts.json
├── 123456789012/
│   ├── eu-central-1/
│   │   ├── kms/
│   │   │   └── file.json
│   │   ├── s3/
│   │   │   └── file.json
│   │   └── ...
│   └── eu-west-1/
│       └── ...
└── ...other accounts...
```

The API automatically counts resources and displays them by type and region. Resources you currently have:

- **390209512651** (sandbox): SSM resources in eu-central-1
- **993581059430** (staging): SSM resources in eu-central-1
- **690025998313** (prod): SSM resources in eu-central-1
- **Other accounts**: No resources (yet)

Add more resource files (kms.json, s3.json, lambda.json, etc.) to any region directory and they'll appear automatically!

## Styling

The dashboard uses a clean, AWS-inspired design with:
- AWS Orange (#ff9900) accent color
- Dark blue (#232f3e) for headers
- Responsive card-based layouts
- Smooth transitions and hover effects
- Mobile-friendly CSS Grid layouts

## Next Steps

### Extend with More Resources

To add CRUD for other resource types (e.g., EC2 instances, Lambda functions), follow this pattern:

1. Create pages at `/dashboard/resources/{type}/` 
2. Create API routes at `/api/resources/{type}/route.ts`
3. Implement read from your data directories
4. Add create/update/delete forms

### Add Real AWS Integration

To connect to actual AWS accounts:

1. Install AWS SDK: `npm install @aws-sdk/client-sts @aws-sdk/client-organizations`
2. Update API routes to call AWS APIs
3. Cache results in your database
4. Add account validation against real AWS

### Add Resource Editing

Currently showing resource counts. To actually edit resources:

1. Create dedicated resource detail pages
2. Add forms for resource properties
3. Implement update logic in API routes
4. Add validations for resource constraints

## Troubleshooting

### Port Already in Use

If port 3001 is busy, Next.js will use the next available port. Check the console output for which port it's using.

### No Resources Showing

Make sure your resource directories follow the expected structure:
- `/db/{accountId}/{region}/{resourceType}/`
- Each resource should be a separate JSON file

### Account Not Saving

Check that `/db/accounts.json` is writable and the JSON is valid.

## Building for Production

```bash
npm run build
npm run start
```

This creates an optimized production build that's smaller and faster.

## Technologies Used

- **Next.js 16** - React framework with file-based routing
- **TypeScript** - Type-safe JavaScript
- **CSS Modules** - Scoped styles
- **Node.js File System API** - For reading/writing account data
- **REST API** - Standard HTTP methods for CRUD operations

Enjoy your new AWS resource dashboard! 🎉
