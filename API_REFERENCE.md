# API Reference - AWS Account CRUD Dashboard

Complete endpoint documentation for the account management API.

## Base URL

```
http://localhost:3001/api
```

---

## Accounts Endpoints

### 1. List All Accounts

**Endpoint**: `GET /accounts`

**Description**: Retrieve all AWS accounts in the system.

**Request**:
```bash
curl http://localhost:3001/api/accounts
```

**Response** (200 OK):
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
  },
  {
    "id": "098765432109",
    "name": "Development",
    "email": "dev@example.com",
    "joinMethod": "CREATED",
    "joinedTimestamp": 1694258000000,
    "requestedTimestamp": 1694258000000
  }
]
```

**Error Response** (500):
```json
{ "error": "Failed to read accounts" }
```

---

### 2. Create New Account

**Endpoint**: `POST /accounts`

**Description**: Create a new AWS account entry.

**Request**:
```bash
curl -X POST http://localhost:3001/api/accounts \
  -H "Content-Type: application/json" \
  -d '{
    "id": "111222333444",
    "name": "Staging",
    "email": "staging@example.com",
    "joinMethod": "CREATED",
    "joinedTimestamp": 1704067200000,
    "requestedTimestamp": 1704067200000
  }'
```

**Request Body Schema**:
```typescript
{
  id: string;                    // 12-digit AWS account ID (required)
  name: string;                  // Account name (required)
  email: string;                 // Contact email (required)
  joinMethod: string;            // "CREATED" | "INVITED" | "IMPORTED" (required)
  joinedTimestamp: number;       // Milliseconds since epoch (required)
  requestedTimestamp: number;    // Milliseconds since epoch (required)
  completedTimestamp?: number;   // Optional, can be added later
}
```

**Response** (201 Created):
```json
{
  "id": "111222333444",
  "name": "Staging",
  "email": "staging@example.com",
  "joinMethod": "CREATED",
  "joinedTimestamp": 1704067200000,
  "requestedTimestamp": 1704067200000
}
```

**Error Responses**:

Duplicate ID (409):
```json
{ "error": "Account with this ID already exists" }
```

General Error (500):
```json
{ "error": "Failed to create account" }
```

---

### 3. Get Single Account

**Endpoint**: `GET /accounts/{accountId}`

**Description**: Retrieve details for a specific account.

**Request**:
```bash
curl http://localhost:3001/api/accounts/123456789012
```

**Response** (200 OK):
```json
{
  "id": "123456789012",
  "name": "Production",
  "email": "prod@example.com",
  "joinMethod": "CREATED",
  "joinedTimestamp": 1694257998383,
  "requestedTimestamp": 1694257998383
}
```

**Error Responses**:

Not Found (404):
```json
{ "error": "Account not found" }
```

Read Error (500):
```json
{ "error": "Failed to read account" }
```

---

### 4. Update Account

**Endpoint**: `PUT /accounts/{accountId}`

**Description**: Update account details. Preserves immutable fields (id, joinedTimestamp).

**Request**:
```bash
curl -X PUT http://localhost:3001/api/accounts/123456789012 \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Production US",
    "email": "prod-us@example.com",
    "joinMethod": "INVITED"
  }'
```

**Request Body Schema**:
```typescript
{
  name?: string;           // Update account name
  email?: string;          // Update email
  joinMethod?: string;     // Change join method
}
```

**Immutable Fields** (cannot be changed):
- `id` - Account ID
- `joinedTimestamp` - Original join timestamp

**Response** (200 OK):
```json
{
  "id": "123456789012",
  "name": "Production US",
  "email": "prod-us@example.com",
  "joinMethod": "INVITED",
  "joinedTimestamp": 1694257998383,
  "requestedTimestamp": 1694257998383
}
```

**Error Responses**:

Not Found (404):
```json
{ "error": "Account not found" }
```

Update Error (500):
```json
{ "error": "Failed to update account" }
```

---

### 5. Delete Account

**Endpoint**: `DELETE /accounts/{accountId}`

**Description**: Delete an account. This operation cannot be undone.

**Request**:
```bash
curl -X DELETE http://localhost:3001/api/accounts/123456789012
```

**Response** (200 OK):
```json
{
  "message": "Account deleted"
}
```

**Error Responses**:

Not Found (404):
```json
{ "error": "Account not found" }
```

Delete Error (500):
```json
{ "error": "Failed to delete account" }
```

---

## Resources Endpoints

### 6. Get Account Resources

**Endpoint**: `GET /accounts/{accountId}/resources`

**Description**: Get AWS resources associated with an account, automatically discovered from the file system.

**Request**:
```bash
curl http://localhost:3001/api/accounts/123456789012/resources
```

**Response** (200 OK):
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
  },
  {
    "type": "Lambda",
    "region": "eu-west-1",
    "count": 2
  },
  {
    "type": "RDS",
    "region": "eu-west-1",
    "count": 1
  }
]
```

**Response Schema**:
```typescript
Array<{
  type: string;      // Resource type (KMS, S3, Lambda, RDS, etc.)
  region: string;    // AWS region
  count: number;     // Number of resources of this type in this region
}>
```

**Supported Resource Types**:
- KMS
- S3
- Lambda
- RDS-DB (RDS Databases)
- CloudWatch
- ECR
- SSM
- EFS (Elastic File System)
- Secrets Manager

**Error Response** (500):
```json
{ "error": "Failed to read resources" }
```

**Note**: Returns empty array if account has no resources yet.

---

## Usage Examples

### JavaScript/Node.js

```javascript
// List all accounts
async function getAccounts() {
  const response = await fetch('http://localhost:3001/api/accounts');
  return await response.json();
}

// Create account
async function createAccount(data) {
  const response = await fetch('http://localhost:3001/api/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  return await response.json();
}

// Update account
async function updateAccount(id, updates) {
  const response = await fetch(`http://localhost:3001/api/accounts/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates)
  });
  return await response.json();
}

// Delete account
async function deleteAccount(id) {
  return await fetch(`http://localhost:3001/api/accounts/${id}`, {
    method: 'DELETE'
  });
}

// Get resources
async function getResources(id) {
  const response = await fetch(`http://localhost:3001/api/accounts/${id}/resources`);
  return await response.json();
}
```

### Python

```python
import requests
import json

BASE_URL = "http://localhost:3001/api"

# List accounts
response = requests.get(f"{BASE_URL}/accounts")
accounts = response.json()

# Create account
new_account = {
    "id": "999888777666",
    "name": "My Account",
    "email": "my@example.com",
    "joinMethod": "CREATED",
    "joinedTimestamp": int(time.time() * 1000),
    "requestedTimestamp": int(time.time() * 1000)
}
response = requests.post(f"{BASE_URL}/accounts", json=new_account)

# Update account
updates = {
    "name": "Updated Name",
    "email": "new@example.com"
}
response = requests.put(f"{BASE_URL}/accounts/123456789012", json=updates)

# Delete account
response = requests.delete(f"{BASE_URL}/accounts/123456789012")

# Get resources
response = requests.get(f"{BASE_URL}/accounts/123456789012/resources")
resources = response.json()
```

### Bash/cURL

```bash
# Create account
curl -X POST http://localhost:3001/api/accounts \
  -H "Content-Type: application/json" \
  -d "{
    \"id\": \"999888777666\",
    \"name\": \"New Account\",
    \"email\": \"new@example.com\",
    \"joinMethod\": \"CREATED\",
    \"joinedTimestamp\": $(date +%s)000,
    \"requestedTimestamp\": $(date +%s)000
  }"

# Update in loop
for id in 123456789012 098765432109; do
  curl -X PUT http://localhost:3001/api/accounts/$id \
    -H "Content-Type: application/json" \
    -d '{"name": "Updated"}'
done

# Delete all and recreate
curl -X DELETE http://localhost:3001/api/accounts/123456789012
```

---

## HTTP Status Codes

| Code | Meaning | When |
|------|---------|------|
| 200 | OK | Successful GET, PUT, DELETE |
| 201 | Created | Successful POST (new resource) |
| 404 | Not Found | Account doesn't exist |
| 409 | Conflict | Account ID already exists |
| 500 | Server Error | File I/O error |

---

## Error Handling

All error responses follow the pattern:

```json
{
  "error": "Descriptive error message"
}
```

Always check `response.ok` or HTTP status code before processing response data:

```javascript
const response = await fetch(url);
if (!response.ok) {
  const error = await response.json();
  console.error('API Error:', error.error);
} else {
  const data = await response.json();
  // Process data
}
```

---

## Rate Limiting

Currently: **No rate limiting** (all operations unlimited)

For production, consider adding:
- 100 requests per minute per IP
- Request signing/authentication
- API key validation

---

## CORS Policy

Currently: **No CORS restrictions** (all origins allowed)

For production, restrict to your domain:
```typescript
const ALLOWED_ORIGINS = ['http://localhost:3001', 'https://your-domain.com'];
```

---

## Data Persistence

- **Storage**: `/db/accounts.json`
- **Format**: JSON array
- **Persistence**: File-based (survives server restarts)
- **Atomicity**: Entire file rewritten per operation (not transaction-safe)

---

## Performance Notes

- **Read latency**: ~1-5ms (entire file read)
- **Write latency**: ~10-50ms (entire file rewrite)
- **Safe concurrency**: <10 simultaneous requests
- **File size limit**: No practical limit for thousands of accounts

For higher concurrency/scale, migrate to SQLite or PostgreSQL.

---

## Troubleshooting

### 404 Not Found
- Verify account ID exists: `GET /api/accounts`
- Check exact 12-digit format

### 409 Conflict
- Account ID already exists
- Delete old account or use different ID

### 500 Server Error
- Check file permissions on `/db/accounts.json`
- Verify JSON syntax if manually edited
- Restart server: `npm run dev`

### Slow Responses
- Multiple concurrent requests?
- Try again after 1 second
- Consider upgrading to database for production

---

## Limits & Constraints

| Constraint | Value |
|-----------|-------|
| Account ID | 12 digits (AWS format) |
| Max name length | Recommended <100 chars |
| Max email length | <255 chars |
| Max resources per account | Unlimited |
| Concurrent requests | <10 recommended |
| File size | Limited by filesystem |

---

## Future API Enhancements

Planned for future versions:
- Bulk operations (import/export)
- Filtering/search parameters
- Pagination support
- Resource CRUD operations
- Real AWS integration
- Authentication & authorization
- Audit logging
- Webhooks
