# UI Components Guide - CRUD Dashboard

Visual reference for all dashboard pages and their functionality.

## 1. Dashboard Home Page

**URL**: `http://localhost:3001/dashboard`

```
┌─────────────────────────────────────────────────────────┐
│ AWS Resource Dashboard                  [+ Add Account] │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │   TEST      │  │    HALLO    │  │     dev     │    │
│  │ 867200652830│  │123456789012 │  │446705532112 │    │
│  │ jaccopk@    │  │ jaccopk@    │  │ dev@        │    │
│  │ gmail.com   │  │ gmail.com   │  │ example.com │    │
│  │ CREATED     │  │ CREATED     │  │ CREATED     │    │
│  │ 10/21/2025  │  │ 10/21/2025  │  │ 11/4/2025   │    │
│  └─────────────┘  └─────────────┘  └─────────────┘    │
│                                                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │
│  │    prod     │  │   staging   │  │   sandbox   │    │
│  │690025998313 │  │993581059430 │  │390209512651 │    │
│  │ prod@       │  │ staging@    │  │ sandbox@    │    │
│  │ example.com │  │ example.com │  │ example.com │    │
│  │ CREATED     │  │ CREATED     │  │ CREATED     │    │
│  │ 11/4/2025   │  │ 11/4/2025   │  │ 11/4/2025   │    │
│  └─────────────┘  └─────────────┘  └─────────────┘    │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

**Features**:
- Grid of account cards (responsive)
- Click card → navigate to account details
- "+ Add Account" button → create new account
- Loading state while fetching
- Error message display (if any)

---

## 2. Create Account Page

**URL**: `http://localhost:3001/dashboard/accounts/new`

```
┌─────────────────────────────────────────────────────────┐
│ ← Back    Add New Account                               │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  Account ID *                                           │
│  [_________________________]                            │
│  e.g., 123456789012                                    │
│                                                          │
│  Account Name *                                         │
│  [_________________________]                            │
│  e.g., Production                                      │
│                                                          │
│  Email *                                                │
│  [_________________________]                            │
│  contact@example.com                                   │
│                                                          │
│  Join Method                                            │
│  [▼ CREATED         ]                                   │
│     ├─ CREATED                                          │
│     ├─ INVITED                                          │
│     └─ IMPORTED                                         │
│                                                          │
│  [Create Account]  [Cancel]                            │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

**Features**:
- Form validation (12-digit ID, email format)
- Required field indicators (*)
- Success → redirect to dashboard
- Error message display
- "Cancel" button to go back

---

## 3. Account Details Page (View Mode)

**URL**: `http://localhost:3001/dashboard/accounts/123456789012`

```
┌─────────────────────────────────────────────────────────┐
│ ← Back    Production                      [Edit] [Back] │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌─ Account Information ──────────────────────────────┐ │
│  │                                                    │ │
│  │ Account ID:      123456789012                     │ │
│  │ Name:            Production                       │ │
│  │ Email:           prod@example.com                 │ │
│  │ Join Method:     CREATED                          │ │
│  │ Joined:          1/23/2024, 1:00:00 PM            │ │
│  │                                                    │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌─ AWS Resources ────────────────────────────────────┐ │
│  │                                                    │ │
│  │ ┌──────────────┐  ┌──────────────┐               │ │
│  │ │ KMS          │  │ S3           │               │ │
│  │ │ eu-central-1 │  │ eu-central-1 │               │ │
│  │ │ 3 resources  │  │ 5 resources  │               │ │
│  │ └──────────────┘  └──────────────┘               │ │
│  │                                                    │ │
│  │ ┌──────────────┐  ┌──────────────┐               │ │
│  │ │ Lambda       │  │ RDS          │               │ │
│  │ │ eu-west-1   │  │ eu-west-1    │               │ │
│  │ │ 2 resources  │  │ 1 resource   │               │ │
│  │ └──────────────┘  └──────────────┘               │ │
│  │                                                    │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

**Features**:
- Account details in read-only format
- Resource cards showing type, region, count
- Hover effects on resource cards
- "Edit" button to switch to edit mode
- Back button to return to dashboard

---

## 4. Account Details Page (Edit Mode)

**URL**: `http://localhost:3001/dashboard/accounts/123456789012` (with Edit activated)

```
┌─────────────────────────────────────────────────────────┐
│ ← Back    Production                    [Cancel] [Back] │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  Account Name                                           │
│  [_________________________]                            │
│  Current: Production                                   │
│                                                          │
│  Email                                                  │
│  [_________________________]                            │
│  Current: prod@example.com                             │
│                                                          │
│  Join Method                                            │
│  [▼ CREATED         ]                                   │
│     ├─ CREATED                                          │
│     ├─ INVITED                                          │
│     └─ IMPORTED                                         │
│                                                          │
│  [Save Changes]  [Delete Account]                      │
│                                                          │
│  ⚠️  Note: Account ID and Join Date cannot be changed  │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

**Features**:
- Editable form fields
- Pre-filled with current values
- Save changes button
- Delete account button (red, dangerous action)
- Cancel button to return to view mode
- Warning about immutable fields
- Confirmation dialog on delete

---

## 5. Navigation Bar (All Pages)

```
┌─────────────────────────────────────────────────────────┐
│ AWS Console  ├─  [Home]  ├─  [Dashboard]                │
└─────────────────────────────────────────────────────────┘
```

**Features**:
- Persistent across all pages
- AWS-themed styling (orange logo)
- Links to Home and Dashboard
- Sticky positioning (stays visible when scrolling)

---

## 6. Responsive Design (Mobile)

**Mobile View (Account Card)**:
```
┌──────────────────────┐
│      TEST            │
│  867200652830        │
│  jaccopk@gmail.com   │
│                      │
│  CREATED    10/21/25 │
└──────────────────────┘
```

**Mobile View (Form)**:
```
┌──────────────────────┐
│ ← Back               │
│ Add New Account      │
├──────────────────────┤
│                      │
│ Account ID *         │
│ [____________]       │
│                      │
│ Account Name *       │
│ [____________]       │
│                      │
│ Email *              │
│ [____________]       │
│                      │
│ Join Method          │
│ [▼ CREATED    ]      │
│                      │
│ [Create Account]     │
│ [Cancel]             │
│                      │
└──────────────────────┘
```

**Features**:
- Single column layout on mobile
- Full-width buttons
- Touch-friendly spacing
- Readable font sizes

---

## 7. Error States

**API Error**:
```
┌─────────────────────────────────────────────────────────┐
│ ⚠️  Failed to read accounts                              │
│    Please try again later.                              │
└─────────────────────────────────────────────────────────┘
```

**Form Validation Error**:
```
Account ID *
[999888777] ← Invalid format
⚠️ Must be a 12-digit AWS account ID
```

**Delete Confirmation**:
```
┌─────────────────────────────────────┐
│  Delete account "Production"?        │
│  This action cannot be undone.       │
│                                     │
│  [Confirm Delete]  [Cancel]         │
└─────────────────────────────────────┘
```

---

## 8. Loading States

**Dashboard Loading**:
```
┌─────────────────────────────────────────────────────────┐
│ AWS Resource Dashboard                  [+ Add Account] │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  Loading...                                             │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

**Form Submitting**:
```
[Create Account...]  ← Button appears disabled while processing
```

---

## Color Palette

| Element | Color | Usage |
|---------|-------|-------|
| Primary | #ff9900 (Orange) | Buttons, hover effects, accents |
| Secondary | #232f3e (Dark Blue) | Headers, text, navigation |
| Background | #ffffff (White) | Cards, forms |
| Light BG | #f5f5f5 (Light Gray) | Section backgrounds |
| Border | #ddd (Light Gray) | Card borders |
| Text | #232f3e (Dark Blue) | Main text |
| Muted Text | #999 (Gray) | Secondary text |
| Error | #c33 (Red) | Error messages |
| Success | #0d6 (Green) | Success states |
| Info | #0066cc (Blue) | Info badges |

---

## Typography

| Element | Size | Weight | Usage |
|---------|------|--------|-------|
| Page Title | 2.0rem | 700 | Dashboard title |
| Section Title | 1.25rem | 600 | Card titles |
| Body Text | 1.0rem | 400 | Form labels, descriptions |
| Small Text | 0.85rem | 400 | Metadata, hints |
| Monospace | 0.9rem | 400 | Account IDs, technical values |

---

## Spacing System

| Size | Pixels | Usage |
|------|--------|-------|
| XS | 0.5rem | Fine details |
| S | 0.75rem | Padding, margins |
| M | 1rem | Standard spacing |
| L | 1.5rem | Section spacing |
| XL | 2rem | Page padding |
| XXL | 3rem | Large sections |

---

## Interactions

**Button Hover**:
- Background color changes
- Slight shadow appears
- Cursor changes to pointer

**Card Hover**:
- Border color changes to orange
- Subtle shadow
- Slight lift effect (transform: translateY(-2px))

**Form Input Focus**:
- Border changes to orange
- Light orange background glow
- Outline removed

**Links Hover**:
- Color changes to orange
- Underline appears (for navigation links)

---

## Accessibility Features

- ✓ Semantic HTML elements
- ✓ Form labels properly associated
- ✓ Focus indicators visible
- ✓ Color contrast meets WCAG AA
- ✓ Keyboard navigation supported
- ✓ Error messages clear and descriptive
- ✓ Confirmation dialogs for dangerous actions
- ✓ Loading states indicated
- ✓ Screen reader friendly

---

## Animation & Transitions

All transitions use **0.3s ease** timing:

```css
transition: background-color 0.3s;
transition: border-color 0.3s;
transition: box-shadow 0.3s;
transition: transform 0.3s;
```

Effects:
- Smooth color transitions on hover
- Subtle shadows for depth
- Quick response to user actions
- No jarring movements

---

## Responsive Breakpoints

| Breakpoint | Width | Layout |
|-----------|-------|--------|
| Mobile | < 768px | Single column |
| Tablet | 768-1024px | 2 column grid |
| Desktop | > 1024px | 3+ column grid |

Grid template:
```css
grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
```

This ensures:
- Minimum card width of 300px
- Automatically wraps to next row
- Fills available space evenly
- Responsive without media queries
