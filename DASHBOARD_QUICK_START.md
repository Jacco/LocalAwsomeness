# Quick Start Guide - CRUD Dashboard

## Start the Server

```bash
cd /Users/jacco/AdventOfCode2025/react/jpk-app
npm run dev
```

Server runs on: **http://localhost:3001**

## Access Points

| Page | URL | Purpose |
|------|-----|---------|
| Dashboard Home | `/dashboard` | View all accounts in a grid |
| New Account | `/dashboard/accounts/new` | Add a new account |
| Account Details | `/dashboard/accounts/{ID}` | View/edit specific account & resources |
| API - List Accounts | `/api/accounts` | GET all accounts (JSON) |
| API - Create Account | `/api/accounts` | POST new account |
| API - Get Resources | `/api/accounts/{ID}/resources` | GET resources for account |

## What You Can Do

### 🎯 Via Web Interface

1. **View All Accounts**: Dashboard shows cards for each account
2. **Add Account**: Click "+ Add Account" button
   - Enter 12-digit AWS Account ID
   - Enter account name and email
   - Choose join method (Created/Invited/Imported)
3. **View Details**: Click any account card to see:
   - Full account information
   - Resource counts by type and region
4. **Edit Account**: Click "Edit" button
   - Change name, email, join method
   - Can't change account ID or join date
5. **Delete Account**: Click "Delete Account" in edit mode
   - Confirmation required

### 📡 Via API Calls

**List all accounts:**
```bash
curl http://localhost:3001/api/accounts
```

**Get specific account:**
```bash
curl http://localhost:3001/api/accounts/123456789012
```

**Create new account:**
```bash
curl -X POST http://localhost:3001/api/accounts \
  -H "Content-Type: application/json" \
  -d '{
    "id": "999888777666",
    "name": "My New Account",
    "email": "admin@example.com",
    "joinMethod": "CREATED",
    "joinedTimestamp": 1704067200000,
    "requestedTimestamp": 1704067200000
  }'
```

**Update account:**
```bash
curl -X PUT http://localhost:3001/api/accounts/123456789012 \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Updated Name",
    "email": "newemail@example.com"
  }'
```

**Delete account:**
```bash
curl -X DELETE http://localhost:3001/api/accounts/123456789012
```

**Get resources for account:**
```bash
curl http://localhost:3001/api/accounts/123456789012/resources
```

## Current Accounts

The system loads these accounts from `db/accounts.json`:

| ID | Name | Email |
|---|---|---|
| 867200652830 | TEST | jaccopk@gmail.com |
| 123456789012 | HALLO | jaccopk@gmail.com |
| 446705532112 | dev | dev@example.com |
| 690025998313 | prod | prod@example.com |
| 993581059430 | staging | staging@example.com |
| 390209512651 | sandbox | sandbox@example.com |

## Files Added

### Pages (UI)
- `src/app/dashboard/page.tsx` - Main dashboard view
- `src/app/dashboard/accounts/new/page.tsx` - Create account form
- `src/app/dashboard/accounts/[id]/page.tsx` - View/edit account details

### Styles
- `src/app/dashboard/dashboard.module.css` - Dashboard styles
- `src/app/dashboard/accounts/accounts.module.css` - Account page styles
- `src/app/layout.css` - Navigation bar styles

### APIs
- `src/app/api/accounts/route.ts` - GET all, POST new
- `src/app/api/accounts/[id]/route.ts` - GET one, PUT update, DELETE
- `src/app/api/accounts/[id]/resources/route.ts` - GET resources count

### Navigation
- Updated `src/app/layout.tsx` - Added navbar with dashboard link

## Build & Deploy

```bash
# Test build
npm run build

# Run production
npm run start
```

## Troubleshooting

**"Account not found"** → Account ID doesn't exist, check /api/accounts

**"Failed to save"** → File permissions issue with db/accounts.json

**Port 3001 busy?** → Server will use next available port, check console output

**Resources showing as 0?** → Create resource directories at `db/{accountId}/{region}/{type}/`

## Next: Add Resource CRUD

Want to manage actual resources (not just counts)? Follow the same pattern:
1. Create forms at `/dashboard/resources/[type]/`
2. Create APIs at `/api/resources/[type]/route.ts`
3. Add forms for create/update
4. Wire up to file system or real AWS APIs

Good luck! 🚀
