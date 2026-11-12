# Phase 1: Cross-Cutting Directory Moves - Checklist

Start here for the first refactoring push. These moves separate concerns and clean up the directory structure.

---

## Move 1A: `src/app/api/db/` → `src/app/data/` ⏱️ 1-2 hours

### Step 1: Create target directory structure

```bash
mkdir -p src/app/data
```

### Step 2: Move all db files

```bash
mv src/app/api/db/* src/app/data/
rmdir src/app/api/db
```

### Step 3: Update imports in all affected files

Files that import from `../db/`:
```bash
grep -r "from ['\"]\.\.\/\.\.\/db\/" src/app/api --include="*.ts" | wc -l
```

**Expected:** ~25-30 files

Use find-and-replace to update:
```
Old: from '../../db/'
New: from '../../../data/'
```

**Services to check:**
- `src/app/api/ec2/**/*.ts`
- `src/app/api/lambda/**/*.ts`
- `src/app/api/iam/**/*.ts`
- `src/app/api/organizations/**/*.ts`
- `src/app/api/ssm/**/*.ts`
- `src/app/api/logs/**/*.ts`
- `src/app/api/kms/**/*.ts`
- Middleware files

### Step 4: Update imports in test files

```bash
grep -r "from ['\"]\.\.\/\.\.\/db\/" src/app/api/__tests__ --include="*.ts"
```

### Step 5: Verify build

```bash
npm run build 2>&1 | head -50
```

Should show: **Build successful** ✅

### Step 6: Run tests

```bash
npm test -- --testPathPattern="(ec2|lambda|iam|organizations)" 2>&1 | tail -30
```

Expected: All tests pass ✅

### Step 7: Commit

```bash
git add -A
git commit -m "refactor: Move db/ → src/app/data/

- Moves persistent state layer out of api directory
- Updates all imports in 30+ files
- All tests passing"
```

### Step 8: Tag for rollback

```bash
git tag -a refactor-phase-1a-complete -m "After db→data move, all tests passing"
```

---

## Move 1B: `src/app/api/runtime/` → `src/lib/lambda-runtime/` ⏱️ 30 minutes

### Step 1: Create target structure

```bash
mkdir -p src/lib/lambda-runtime
```

### Step 2: Move files

```bash
mv src/app/api/runtime/* src/lib/lambda-runtime/
rmdir src/app/api/runtime
```

### Step 3: Update Lambda service imports

Find files in `src/app/api/lambda/` that import from runtime:

```bash
grep -r "from ['\"]\.\.\/\.\.\/runtime\/" src/app/api/lambda --include="*.ts"
```

Update to: `from '../../../lib/lambda-runtime/'`

### Step 4: Build and test

```bash
npm run build
npm test -- lambda
```

### Step 5: Commit

```bash
git add -A
git commit -m "refactor: Move runtime/ → src/lib/lambda-runtime/

- Lambda runtime and netshim moved to shared lib
- Updates Lambda service imports"
```

### Step 6: Tag

```bash
git tag -a refactor-phase-1b-complete -m "After runtime→lib move"
```

---

## Move 1C: `src/app/api/policy/` → `src/app/auth/policy/` ⏱️ 30 minutes

### Step 1: Create target structure

```bash
mkdir -p src/app/auth/policy
```

### Step 2: Move files

```bash
mv src/app/api/policy/* src/app/auth/policy/
rmdir src/app/api/policy
```

### Step 3: Create README for auth layer

```bash
cat > src/app/auth/README.md << 'EOF'
# Authorization Layer

Cross-cutting authorization and policy management.

## Components

- `policy/` - Policy evaluation engine
- `authorizer.ts` - Request authorization
- `principal.ts` - Principal identity management

## Usage

Services use this layer to:
- Evaluate IAM policies
- Check principal permissions
- Enforce access control

## Tests

Run authorization tests:
```bash
npm test -- auth
```
EOF
```

### Step 4: Find all imports of policy

```bash
grep -r "from ['\"]\.\.\/\.\.\/policy\/" src --include="*.ts" | grep -v node_modules
```

### Step 5: Update imports

All references should change:
```
Old: from '../../policy/'
New: from '../../auth/policy/'
```

### Step 6: Build and test

```bash
npm run build
npm test
```

### Step 7: Commit

```bash
git add -A
git commit -m "refactor: Move policy/ → src/app/auth/policy/

- Authorization layer separated into app/auth
- Proper separation of concerns
- Policy evaluation centralized"
```

### Step 8: Tag

```bash
git tag -a refactor-phase-1c-complete -m "After policy→auth move"
```

---

## Move 1D: `src/app/api/network/` → `src/app/analysis/network/` ⏱️ 2-3 hours

**⚠️ CRITICAL PATH - Network evidence must remain unchanged**

### Step 1: Create target structure

```bash
mkdir -p src/app/analysis/network
```

### Step 2: Move files

```bash
mv src/app/api/network/* src/app/analysis/network/
rmdir src/app/api/network
```

### Step 3: Create README for analysis layer

```bash
cat > src/app/analysis/README.md << 'EOF'
# Analysis Layer

Cross-cutting analysis and query services.

## Components

- `network/` - Network connectivity analysis
  - `reach.ts` - Network trace engine
  - `routes.ts` - Route resolution
  - `trace.ts` - Trace data model
  - `live.ts` - Live network queries

## Usage

Services use this layer to:
- Trace network connectivity
- Resolve route paths
- Analyze security policies
- Generate network evidence

## Integration

Network analysis is integrated with:
- EC2 service (VPC, routes, security groups)
- Lambda service (VPC attachment, ENI)
- All services that use network connectivity

## Tests

```bash
npm test -- network
```

**IMPORTANT:** Network evidence format and types are stable.
Changes to reach.ts or trace.ts must not modify Evidence output format.
EOF
```

### Step 4: Find all imports of network

```bash
grep -r "from ['\"]\.\.\/\.\.\/network\/" src/app/api --include="*.ts" | head -20
```

**Expected high-impact files:**
- `src/app/api/ec2/**/*.ts`
- `src/app/api/lambda/**/*.ts`
- Handler middleware

### Step 5: Update imports in services

Replace all:
```
Old: from '../../network/'
New: from '../../analysis/network/'
```

### Step 6: Update imports in tests

```bash
grep -r "from ['\"]\.\.\/\.\.\/network\/" src --include="*.ts" | grep -v node_modules
```

### Step 7: CRITICAL - Verify network evidence unchanged

Before committing, run this test:

```bash
npm test -- network 2>&1 | grep -E "(PASS|FAIL|test suites|tests)"
```

Expected:
```
PASS  src/app/api/network/__tests__/network.test.ts
PASS  src/app/api/network/__tests__/network-live.test.ts
```

**Verify evidence types:**
```typescript
// In test output, look for these kinds (should be unchanged):
// - 'route'
// - 'security-group'
// - 'network-acl'
// - 'network-interface'
// - 'blackhole'
```

### Step 8: Run EC2 tests (uses network analysis)

```bash
npm test -- ec2 2>&1 | tail -20
```

Expected: All pass ✅

### Step 9: Run Lambda tests (uses network analysis)

```bash
npm test -- lambda 2>&1 | tail -20
```

Expected: All pass ✅

### Step 10: Verify build

```bash
npm run build
```

Expected: Clean build ✅

### Step 11: Run Terraform integration tests

```bash
cd tests/terraform
terraform test -verbose
```

Expected: All scenarios pass ✅

### Step 12: Check network output format

Create quick validation:

```bash
npm test -- network 2>&1 | grep -A5 "Evidence\|trace\|kind"
```

Ensure no output format changes to Evidence.

### Step 13: Commit

```bash
git add -A
git commit -m "refactor: Move network/ → src/app/analysis/network/

CRITICAL VALIDATION:
  ✅ All network tests pass (25 + 8)
  ✅ EC2 tests pass (58)
  ✅ Lambda tests pass
  ✅ Terraform integration tests pass
  ✅ Network evidence format unchanged
  ✅ Evidence kinds unchanged
  ✅ Build clean

- Network analysis moved to analysis layer
- Separation of concerns (analysis vs API)
- All imports updated (40+ files)
- No functional changes"
```

### Step 14: Tag

```bash
git tag -a refactor-phase-1d-complete -m "After network→analysis move, all tests passing, evidence unchanged"
```

---

## Move 1E: Reorganize `resources/s3/` within S3 service ⏱️ 30 minutes

### Step 1: Move into S3 service

```bash
mv src/app/api/resources/s3 src/app/api/s3/resources
rmdir src/app/api/resources
```

### Step 2: Update imports

Find references:
```bash
grep -r "resources/s3" src --include="*.ts"
```

Update to: `s3/resources`

### Step 3: Build and test

```bash
npm run build
npm test -- s3
```

### Step 4: Commit

```bash
git add -A
git commit -m "refactor: Move resources/s3 into S3 service

- Resource inspector now part of S3 service
- Removes resources/ parent directory
- Consolidates S3-related code"
```

### Step 5: Tag

```bash
git tag -a refactor-phase-1e-complete -m "After resources reorganization"
```

---

## Phase 1 Completion Verification

After all 5 moves are complete:

### 1. Verify directory structure

```bash
ls -la src/app/
# Should show: api/, data/, analysis/, auth/, lib/

ls -la src/app/api/
# Should show: ONLY service directories, no db/, network/, policy/, runtime/, resources/
```

Expected directories in `src/app/api/`:
```
account/          ✅
accounts/         ✅
cloudformation/   ✅
cloudtrail/       ✅
ec2/              ✅
elasticfilesystem/ ✅
iam/              ✅
kms/              ✅
lambda/           ✅
logs/             ✅
organizations/    ✅
s3/               ✅ (now includes resources/)
servicequotas/    ✅
ssm/              ✅
sts/              ✅
__tests__/        ✅
```

### 2. Run full test suite

```bash
npm test 2>&1 | tail -20
```

Expected:
```
PASS  src/app/api/...
Test Suites: XX passed, XX total
Tests: XXX passed, XXX total
```

### 3. Build verification

```bash
npm run build 2>&1 | tail -5
```

Expected: Clean build with no errors

### 4. Check git history

```bash
git log --oneline -5
# Should show:
# refactor-phase-1e-complete
# refactor-phase-1d-complete
# refactor-phase-1c-complete
# refactor-phase-1b-complete
# refactor-phase-1a-complete
```

### 5. Final summary

```bash
git diff --stat HEAD~5..HEAD
```

Shows all files changed across all 5 moves.

---

## If Something Breaks

**Rollback to previous step:**

```bash
# Identify which move had the issue
git tag                     # List all refactor tags

# Rollback to previous good state
git reset --hard refactor-phase-1c-complete  # Example: rollback to before 1D

# Identify the problem
# Fix imports/issues manually
# Recommit with the same message but fixed

git commit --amend
```

---

## Next Steps After Phase 1

Once Phase 1 is complete:

1. **Documentation update**
   - Update all architecture diagrams
   - Update contributing guide
   - Update import examples in docs

2. **Start Phase 2 (Service Standardization)**
   - Begin with EC2 (largest, most tests)
   - Create README.md with operation tables
   - Continue with Lambda, IAM, S3, KMS...

3. **Track progress**
   - Update REFACTORING_PLAN.md with completion status
   - Create burndown chart for Phase 2

---

## Phase 1 Estimated Time

- Move 1A (db): 1-2 hours
- Move 1B (runtime): 30 minutes
- Move 1C (policy): 30 minutes
- Move 1D (network): 2-3 hours ⚠️ (CRITICAL)
- Move 1E (resources): 30 minutes
- Testing between moves: ~1-2 hours

**Total Phase 1: 5-7 hours** (1 full working day or 2 half-days)

---

## Success Criteria

✅ All 5 directory moves complete  
✅ All imports updated  
✅ Build is clean  
✅ All tests pass  
✅ Network evidence format unchanged  
✅ Git history shows 5 separate commits  
✅ Ready to commit to main  

---

**Start with Move 1A, follow this checklist step-by-step.**

Each move is independent and can be reverted if issues arise.

Questions? See `docs/REFACTORING_PLAN.md` for full context.
