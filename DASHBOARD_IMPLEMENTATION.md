# CRUD Dashboard - Implementation Details

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                   Web Browser                        │
├─────────────────────────────────────────────────────┤
│  Dashboard UI (React)    ←→    REST APIs            │
├─────────────────────────────────────────────────────┤
│  Next.js Server (Node.js)                           │
├─────────────────────────────────────────────────────┤
│  File System (db/accounts.json)                     │
└─────────────────────────────────────────────────────┘
```

## Component Breakdown

### 1. Pages (User Interfaces)

#### `/dashboard` - Main Dashboard
- **Component**: `src/app/dashboard/page.tsx`
- **Renders**: Grid of account cards
- **Interactions**:
  - Fetch all accounts on load
  - Click card to navigate to details
  - Click button to add new account
- **Data Flow**: Calls `GET /api/accounts`

#### `/dashboard/accounts/new` - Create Account
- **Component**: `src/app/dashboard/accounts/new/page.tsx`
- **Renders**: Form with fields for account creation
- **Interactions**:
  - Fill form (id, name, email, joinMethod)
  - Submit to create account
  - Redirect to dashboard on success
- **Data Flow**: `POST /api/accounts` → redirect `/dashboard`

#### `/dashboard/accounts/[id]` - Account Details & Edit
- **Component**: `src/app/dashboard/accounts/[id]/page.tsx`
- **Renders**: 
  - View mode: Account information + resource counts
  - Edit mode: Form for updating account details
- **Interactions**:
  - Toggle between view and edit
  - Update account details
  - Delete account (with confirmation)
  - See auto-discovered resources
- **Data Flow**: 
  - View: `GET /api/accounts/{id}` + `GET /api/accounts/{id}/resources`
  - Update: `PUT /api/accounts/{id}`
  - Delete: `DELETE /api/accounts/{id}`

### 2. API Routes

#### `GET /api/accounts` - List All Accounts
```
Request: GET /api/accounts
Response: [{id, name, email, joinMethod, joinedTimestamp, ...}, ...]
Logic:
  1. Read /db/accounts.json
  2. Parse JSON
  3. Return as array
Error: 500 if file can't be read
```

#### `POST /api/accounts` - Create Account
```
Request: POST /api/accounts
Body: {id, name, email, joinMethod, joinedTimestamp, requestedTimestamp}
Response: {id, name, email, ...} (201 Created)
Logic:
  1. Parse request body
  2. Check if account ID already exists
  3. Append to accounts array
  4. Write back to file
  5. Return created account
Errors: 
  - 409 if duplicate ID
  - 500 if write fails
```

#### `GET /api/accounts/[id]` - Get Single Account
```
Request: GET /api/accounts/123456789012
Response: {id, name, email, joinMethod, joinedTimestamp, ...}
Logic:
  1. Read accounts.json
  2. Find by ID
  3. Return matching account
Error: 404 if not found, 500 if read fails
```

#### `PUT /api/accounts/[id]` - Update Account
```
Request: PUT /api/accounts/123456789012
Body: {name?, email?, joinMethod?}
Response: {id, name, email, ...} (updated account)
Logic:
  1. Read accounts.json
  2. Find account by ID
  3. Merge provided updates (preserving immutable fields)
  4. Write back to file
  5. Return updated account
Rules:
  - Cannot change: id, joinedTimestamp
  - Can change: name, email, joinMethod
Error: 404 if not found, 500 if write fails
```

#### `DELETE /api/accounts/[id]` - Delete Account
```
Request: DELETE /api/accounts/123456789012
Response: {message: "Account deleted"}
Logic:
  1. Read accounts.json
  2. Filter out account with matching ID
  3. Write filtered array back to file
  4. Return success message
Error: 404 if not found, 500 if write fails
```

#### `GET /api/accounts/[id]/resources` - Get Resources
```
Request: GET /api/accounts/123456789012/resources
Response: [{type, region, count}, ...]
Logic:
  1. Read directory: /db/123456789012/
  2. For each subdirectory (region):
     - For each resource type subdirectory:
       - Count JSON files
       - Add to results: {type, region, count}
  3. Return results array
Error: Returns [] if account dir doesn't exist
```

### 3. Styling

#### CSS Modules (Component-scoped styles)
- `dashboard.module.css` - Main dashboard grid, cards, buttons
- `accounts.module.css` - Forms, detail views, edit mode
- `layout.css` - Navigation bar styling

**Design System**:
- Primary Color: `#ff9900` (AWS Orange)
- Secondary Color: `#232f3e` (AWS Dark Blue)
- Neutral: `#f5f5f5`, `#ddd`, `#999`
- Responsive: CSS Grid with `minmax()` for auto-sizing
- Spacing: 1rem/2rem increments
- Shadows: Subtle box-shadows on hover
- Transitions: 0.3s ease for interactive elements

### 4. Navigation

Updated `layout.tsx`:
- Persistent navigation bar across all pages
- Links to Home and Dashboard
- AWS-themed styling

## Data Flow Examples

### Example 1: View Accounts

```
User visits /dashboard
    ↓
page.tsx useEffect() runs
    ↓
fetch('/api/accounts')
    ↓
route.ts GET handler
    ↓
readFile('db/accounts.json')
    ↓
JSON.parse(content)
    ↓
return accounts array (Response)
    ↓
Front-end receives data
    ↓
Render account cards
```

### Example 2: Create Account

```
User fills form and clicks submit
    ↓
Form onSubmit handler
    ↓
fetch('/api/accounts', {method: 'POST', body: JSON.stringify(formData)})
    ↓
route.ts POST handler
    ↓
request.json() parses body
    ↓
readFile('db/accounts.json')
    ↓
Check if ID exists
    ↓
Append new account to array
    ↓
writeFile('db/accounts.json', JSON.stringify(accounts))
    ↓
return 201 with created account
    ↓
Front-end calls router.push('/dashboard')
    ↓
User redirected to dashboard
```

### Example 3: Update Account

```
User clicks Edit button
    ↓
Page switches to edit mode
    ↓
User changes fields and clicks Save
    ↓
fetch('/api/accounts/[id]', {method: 'PUT', body: JSON.stringify(updates)})
    ↓
route.ts PUT handler
    ↓
request.json() parses body
    ↓
readFile('db/accounts.json')
    ↓
Find account by ID (index)
    ↓
Merge updates: {...account, ...updates, id: preserve, joinedTimestamp: preserve}
    ↓
Replace account at index
    ↓
writeFile('db/accounts.json', JSON.stringify(accounts))
    ↓
return 200 with updated account
    ↓
Front-end updates state
    ↓
Switches back to view mode
```

## Key Technical Decisions

### 1. File-Based Database
**Why**: Simple, no external dependencies, easy to inspect/debug
**Trade-off**: Not suitable for high concurrency or large data

### 2. JSON Format
**Why**: Native to JavaScript, readable, easily parseable
**Trade-off**: Entire file read/write on each operation

### 3. Next.js API Routes
**Why**: Integrated, no separate backend server, type-safe
**Trade-off**: Tied to Next.js framework

### 4. CSS Modules
**Why**: Scoped styles prevent conflicts, good performance
**Trade-off**: Need to import per component

### 5. Client-Side React
**Why**: Instant UI updates, smooth user experience
**Trade-off**: Need to handle loading/error states

## Error Handling

All API routes include try-catch blocks:
```typescript
try {
  // Main logic
} catch (error) {
  return NextResponse.json(
    { error: 'Friendly error message' },
    { status: 500 }
  );
}
```

Front-end error handling:
```typescript
setError(null); // Clear previous errors
try {
  const response = await fetch('/api/...');
  if (!response.ok) throw new Error('...');
  // Process data
} catch (err) {
  setError(err.message); // Display to user
}
```

## Performance Considerations

1. **Account Operations**: O(n) because entire file must be read/written
2. **Resource Discovery**: O(d) where d is directory depth
3. **Caching**: Could cache file reads, but file is small (~1-2KB)
4. **Concurrency**: Multiple simultaneous requests could corrupt file

For production use with high volume, consider:
- SQLite database
- Redis caching
- File locking mechanism
- Connection pooling

## Security Notes

**Current Implementation**:
- No authentication/authorization
- No input validation beyond HTML5 attributes
- No rate limiting
- File system access only

**For Production**:
- Add authentication (JWT, OAuth2)
- Validate all inputs server-side
- Implement rate limiting
- Add audit logging
- Use environment variables for config
- Add CORS restrictions
- Implement request signing

## Testing Checklist

- [x] Build succeeds without errors
- [x] All routes compile (0 TypeScript errors)
- [x] API returns accounts data
- [ ] Can create account via form
- [ ] Can create account via API
- [ ] Can update account via form
- [ ] Can update account via API
- [ ] Can delete account (with confirmation)
- [ ] Resources auto-discovered correctly
- [ ] Navigation works across pages
- [ ] Forms validate correctly
- [ ] Error messages display
- [ ] Responsive design on mobile

To run tests:
```bash
npm run dev
# Manual testing via browser or curl
```

## Future Enhancements

1. **Search/Filter**: Add search box to dashboard
2. **Pagination**: Handle large account lists
3. **Export/Import**: Bulk account management
4. **Resource CRUD**: Full management of actual resources
5. **AWS Integration**: Connect to real AWS accounts
6. **Multi-user**: Add authentication and per-user accounts
7. **Audit Log**: Track changes to accounts
8. **Backup/Restore**: Automated backups
9. **API Keys**: Programmatic access tokens
10. **Dashboard Widgets**: Stats, usage metrics, charts
