# Getting Started with the AWS CRUD Dashboard

Welcome! This guide will help you get up and running with your new AWS account management dashboard.

## 📋 What is This?

A web-based dashboard for managing AWS accounts running on your local Next.js server. Create, read, update, and delete accounts with a clean UI and full REST API.

**Key Benefit**: No browser plugins or complex redirects needed - everything runs locally!

---

## 🚀 Quick Start (5 minutes)

### Step 1: Start the Server

```bash
cd /Users/jacco/AdventOfCode2025/react/jpk-app
npm run dev
```

You'll see:
```
✓ Starting...
- Local:         http://localhost:3001
```

### Step 2: Open Dashboard

Visit in your browser:
```
http://localhost:3001/dashboard
```

You should see a grid of account cards for your 6 existing accounts.

### Step 3: Try It Out

- **View Account**: Click any account card
- **Add Account**: Click "+ Add Account" button
- **Edit Account**: Click "Edit" on account details
- **Delete Account**: Click "Delete Account" (with confirmation)
- **View Resources**: See resource counts by type/region

---

## 📚 Documentation Files

Read these in order for increasing levels of detail:

### 1. **DASHBOARD_QUICK_START.md** (5 min read)
Quick reference for common tasks:
- How to run the server
- Basic CRUD operations via UI
- Curl examples for API calls
- Troubleshooting tips

**👉 Start here if you just want to use the dashboard**

### 2. **DASHBOARD_README.md** (15 min read)
Complete feature documentation:
- Detailed feature descriptions
- File structure overview
- Data storage details
- How to extend with more resources
- Technology stack

**👉 Read this if you want to understand all features**

### 3. **API_REFERENCE.md** (10 min read)
Complete API documentation:
- All 6 endpoints with examples
- Request/response schemas
- Code examples (JavaScript, Python, Bash)
- Error codes and handling
- Performance notes

**👉 Use this to integrate via API or write scripts**

### 4. **DASHBOARD_IMPLEMENTATION.md** (20 min read)
Technical deep dive:
- Architecture overview
- Component breakdown
- Data flow diagrams
- Error handling strategy
- Security considerations
- Future enhancements

**👉 Read this if you want to extend or modify the code**

### 5. **UI_COMPONENTS_GUIDE.md** (10 min read)
Visual reference:
- All page layouts
- Component designs
- Color palette
- Typography
- Responsive design
- Accessibility features

**👉 Useful if you want to customize the UI**

---

## 🎯 Common Tasks

### Task: Add a New Account

**Via Web Interface**:
1. Click dashboard link in navbar
2. Click "+ Add Account" button
3. Fill in the form:
   - Account ID (12 digits)
   - Account Name
   - Email
   - Join Method
4. Click "Create Account"
5. You'll be redirected to dashboard

**Via API**:
```bash
curl -X POST http://localhost:3001/api/accounts \
  -H "Content-Type: application/json" \
  -d '{
    "id": "999888777666",
    "name": "My New Account",
    "email": "my@example.com",
    "joinMethod": "CREATED",
    "joinedTimestamp": 1704067200000,
    "requestedTimestamp": 1704067200000
  }'
```

### Task: View All Accounts (API)

```bash
curl http://localhost:3001/api/accounts | jq .
```

### Task: Update Account Name

**Via Web Interface**:
1. Click on account card
2. Click "Edit" button
3. Change name field
4. Click "Save Changes"

**Via API**:
```bash
curl -X PUT http://localhost:3001/api/accounts/123456789012 \
  -H "Content-Type: application/json" \
  -d '{"name": "New Name"}'
```

### Task: Delete Account

**Via Web Interface**:
1. Click on account card
2. Click "Edit" button
3. Click "Delete Account"
4. Confirm in dialog

**Via API**:
```bash
curl -X DELETE http://localhost:3001/api/accounts/123456789012
```

### Task: Get Resources for Account

```bash
curl http://localhost:3001/api/accounts/123456789012/resources | jq .
```

---

## 🔍 API Endpoints Reference

Quick endpoint reference (full details in API_REFERENCE.md):

```
GET    /api/accounts                   → List all accounts
POST   /api/accounts                   → Create new account
GET    /api/accounts/{id}              → Get single account
PUT    /api/accounts/{id}              → Update account
DELETE /api/accounts/{id}              → Delete account
GET    /api/accounts/{id}/resources    → Get account resources
```

All endpoints return JSON responses.

---

## 📁 Project Structure

```
jpk-app/
├── src/app/
│   ├── dashboard/
│   │   ├── page.tsx                    # Dashboard home
│   │   ├── dashboard.module.css        # Dashboard styles
│   │   └── accounts/
│   │       ├── new/page.tsx            # Create account
│   │       ├── [id]/page.tsx           # View/edit account
│   │       └── accounts.module.css     # Account styles
│   ├── api/
│   │   └── accounts/
│   │       ├── route.ts                # List/create
│   │       ├── [id]/route.ts           # Get/update/delete
│   │       └── [id]/resources/route.ts # Get resources
│   ├── layout.tsx                      # Root layout
│   └── layout.css                      # Nav styles
├── db/
│   └── accounts.json                   # Account data storage
├── GETTING_STARTED.md                  # This file
├── DASHBOARD_QUICK_START.md            # Quick reference
├── DASHBOARD_README.md                 # Full documentation
├── DASHBOARD_IMPLEMENTATION.md         # Technical details
├── API_REFERENCE.md                    # API docs
└── UI_COMPONENTS_GUIDE.md              # UI reference
```

---

## 🛠️ Technical Stack

- **Next.js 16**: React framework with file-based routing
- **TypeScript**: Type-safe JavaScript
- **CSS Modules**: Scoped component styles
- **Node.js File System**: Reading/writing JSON data
- **REST API**: Standard HTTP methods

**No external dependencies!** Uses only built-in Node.js APIs.

---

## 🔧 Customization

### Want to change colors?

Edit: `src/app/dashboard/dashboard.module.css`

Look for:
```css
--primary-color: #ff9900;  /* Orange */
--secondary-color: #232f3e; /* Dark Blue */
```

### Want to add fields to accounts?

1. Update form in `src/app/dashboard/accounts/new/page.tsx`
2. Update API handler in `src/app/api/accounts/route.ts`
3. Update account detail view in `src/app/dashboard/accounts/[id]/page.tsx`

### Want to add more resource types?

Edit: `src/app/api/accounts/[id]/resources/route.ts`

Add directory type to scan, update response format.

---

## 🐛 Troubleshooting

### Issue: "Port 3001 is already in use"

**Solution**: Server uses next available port. Check console for actual port number.

### Issue: "Account not found" error

**Solution**: Account ID doesn't exist. List all accounts first:
```bash
curl http://localhost:3001/api/accounts
```

### Issue: "Failed to save" error

**Solution**: File permissions issue with `/db/accounts.json`

Check permissions:
```bash
ls -l db/accounts.json
chmod 644 db/accounts.json  # Make readable/writable
```

### Issue: No resources showing for account

**Solution**: Resources are auto-discovered from directory structure. Make sure directories exist:
```
db/{accountId}/{region}/{resourceType}/
```

### Issue: Validation error on form

**Solution**: Most fields have validation:
- Account ID must be 12 digits
- Email must be valid format
- Name required
- Fill in all required fields (marked with *)

### Issue: Styles not updating

**Solution**: Clear Next.js cache and rebuild:
```bash
rm -rf .next
npm run build
npm run dev
```

---

## 📊 Current Accounts in System

From `db/accounts.json`:

| ID | Name | Email |
|----|------|-------|
| 867200652830 | TEST | jaccopk@gmail.com |
| 123456789012 | HALLO | jaccopk@gmail.com |
| 446705532112 | dev | dev@example.com |
| 690025998313 | prod | prod@example.com |
| 993581059430 | staging | staging@example.com |
| 390209512651 | sandbox | sandbox@example.com |

Try adding, updating, or deleting these to test functionality!

---

## 🎓 Learning Path

1. **Day 1**: Get it running
   - Start server: `npm run dev`
   - Visit dashboard
   - Try CRUD via web interface
   - Read DASHBOARD_QUICK_START.md

2. **Day 2**: Understand features
   - Use web interface more
   - Try API calls with curl
   - Read DASHBOARD_README.md
   - Explore file structure

3. **Day 3**: Integrate programmatically
   - Write scripts to manage accounts
   - Build API integrations
   - Read API_REFERENCE.md
   - Try Python/Node.js examples

4. **Day 4+**: Extend and customize
   - Modify styles
   - Add new features
   - Connect real AWS accounts
   - Read DASHBOARD_IMPLEMENTATION.md

---

## 🚀 Next Steps

### Immediate (Today)
- [ ] Start server and visit dashboard
- [ ] Create a new test account
- [ ] Edit an account
- [ ] Delete the test account
- [ ] Read DASHBOARD_QUICK_START.md

### Short Term (This Week)
- [ ] Write a script to bulk-import accounts
- [ ] Try API calls in your favorite language
- [ ] Customize colors to match your brand
- [ ] Read all documentation files

### Medium Term (This Month)
- [ ] Add more resource types to track
- [ ] Integrate with real AWS accounts (using AWS SDK)
- [ ] Add search/filter functionality
- [ ] Build scripts for automated updates

### Long Term (This Quarter)
- [ ] Add full resource CRUD (not just counts)
- [ ] Implement authentication/multi-user
- [ ] Add audit logging
- [ ] Deploy to production
- [ ] Migrate to database (SQLite/PostgreSQL)

---

## 💡 Tips & Tricks

### Tip 1: Use curl for quick API tests
```bash
# List accounts
curl http://localhost:3001/api/accounts | jq .

# Pretty-print JSON
curl http://localhost:3001/api/accounts | jq . | less
```

### Tip 2: Write a helper script
```bash
#!/bin/bash
BASE="http://localhost:3001/api"

list_accounts() {
  curl $BASE/accounts
}

add_account() {
  curl -X POST $BASE/accounts \
    -H "Content-Type: application/json" \
    -d "$1"
}
```

### Tip 3: Use jq for filtering
```bash
# Get only prod account
curl http://localhost:3001/api/accounts | jq '.[] | select(.name == "prod")'

# Get all account IDs
curl http://localhost:3001/api/accounts | jq '.[].id'
```

### Tip 4: Batch operations
```bash
# Delete all TEST accounts
curl http://localhost:3001/api/accounts | jq '.[] | select(.name == "TEST") | .id' | \
  xargs -I {} curl -X DELETE http://localhost:3001/api/accounts/{}
```

---

## 📞 Support

### Getting Help

1. **Check documentation**
   - Quick start guide (5 min)
   - Full README (15 min)
   - Implementation details (20 min)

2. **Check troubleshooting**
   - See "Troubleshooting" section above
   - Check error message carefully

3. **Inspect logs**
   - Browser console: Press F12
   - Server console: Check terminal output
   - API responses: Use curl -v

4. **Verify data**
   - Check `/db/accounts.json` directly
   - Ensure JSON is valid
   - Check file permissions

---

## ✅ Verification Checklist

After getting started, verify:

- [x] Server starts: `npm run dev`
- [x] Dashboard loads: `http://localhost:3001/dashboard`
- [x] API works: `curl http://localhost:3001/api/accounts`
- [x] Can see existing accounts
- [x] Can create new account
- [x] Can update account
- [x] Can delete account
- [x] Resources display for accounts

---

## 🎉 You're Ready!

You now have a professional-grade CRUD dashboard running locally. 

**Next step**: Open your browser and visit:

```
http://localhost:3001/dashboard
```

Enjoy! 🚀

---

**Questions?** Check the documentation files in this directory.

**Found a bug?** You can modify the code directly - all files are in `src/`.

**Want to learn more?** Read the technical documentation for architecture details.

Happy coding!
