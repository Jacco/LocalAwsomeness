# Codebase Refactoring: Ready to Start

**Status:** ✅ Planning complete | Ready for immediate execution  
**Complexity:** Medium | 5-7 hours Phase 1, then 20-25 hours Phases 2-3, then 4-6 hours Phase 4  
**Total estimated time:** ~30-40 hours (4-5 working days)  
**Risk level:** Low (each move isolated, continuous validation)  

---

## What's Ready

You have everything you need to start the refactoring:

### 📋 Documentation

1. **REFACTORING_PLAN.md** (13,000 words)
   - Complete strategy and rationale
   - All 5 Phase 1 moves detailed
   - All 12 service standardizations specified
   - Integration testing strategy
   - Rollback procedures

2. **REFACTORING_PHASE1_CHECKLIST.md** (11,000 words)
   - Step-by-step bash commands for each move
   - Import update patterns
   - Build/test verification for each move
   - Git tagging for quick rollback
   - What to do if something breaks

3. **WHAT_YOU_CAN_NOW_DO.md** (user capabilities)
4. **phase4-ec2-implementation.md** (Phase 4.1 summary)
5. **lambda-interface-safety.md** (proof Lambda interfaces won't disappear)
6. **PHASE4_REVISED_PLAN.md** (Transit Gateway Phase 4.2 ready)

---

## Why This Refactoring Matters

### Current State (Problematic)

```
src/app/api/
├── db/                    ❌ Everyone imports this
├── network/               ❌ Used by EC2, Lambda, and handlers
├── policy/                ❌ Authorization middleware scattered
├── resources/s3/          ❌ Resource inspector mixed with API
├── runtime/               ❌ Lambda utilities
├── ec2/                   (service)
├── lambda/                (service)
├── iam/                   (service)
└── [9 more services...]
```

**Problems:**
- "api" directory contains non-API concerns
- Cross-cutting concerns mixed with services
- Import paths are confusing (../../db from deep services)
- Hard to onboard new developers
- Difficult to reason about dependencies

### Target State (Clean)

```
src/app/
├── api/                   ✅ Only services
│   ├── ec2/
│   ├── lambda/
│   ├── s3/
│   ├── iam/
│   └── [12 services]
├── data/                  ✅ Persistent state
├── analysis/              ✅ Query/analysis layer
│   └── network/
├── auth/                  ✅ Authorization
│   └── policy/
└── lib/                   ✅ Utilities
    └── lambda-runtime/
```

**Benefits:**
- Clear separation of concerns
- Easy to understand code organization
- Import paths are clearer (../../data/ vs ../../db/)
- Standard directory structure
- Each service has uniform README with operation tables
- Rigorous Terraform + network evidence testing

---

## Phase 1: The Critical Path (5-7 hours)

The five directory moves that enable everything else:

### 1. db → data (1-2 hours)

Move the persistent state layer out of "api":
```bash
# Command: mv src/app/api/db/* src/app/data/
# Impact: ~30 files need import updates
# Rollback: git reset --hard refactor-phase-1a-complete
```

### 2. runtime → lib (30 minutes)

Lambda utilities belong in a lib:
```bash
# Command: mv src/app/api/runtime/* src/lib/lambda-runtime/
# Impact: Lambda service + tests
# Risk: Low (isolated)
```

### 3. policy → auth (30 minutes)

Authorization layer gets its own parent:
```bash
# Command: mv src/app/api/policy/* src/app/auth/policy/
# Impact: Middleware, some handlers
# Risk: Low (isolated)
```

### 4. network → analysis ⚠️ (2-3 hours - CRITICAL)

Network analysis moves to analysis layer:
```bash
# Command: mv src/app/api/network/* src/app/analysis/network/
# Impact: ~40 files, many services
# CRITICAL: Network evidence format must not change
# Validation: All tests must pass, evidence kinds unchanged
```

### 5. resources → s3 (30 minutes)

Resource inspector stays with S3:
```bash
# Command: mv src/app/api/resources/s3 src/app/api/s3/resources
# Impact: S3 service + tests
# Risk: Low (isolated)
```

### Verification After Phase 1

All moves will have been validated:
```
✅ Build passes
✅ All tests pass (91 tests)
✅ Terraform integration tests pass
✅ Network evidence format unchanged
✅ Git history shows 5 clean commits
✅ All import paths updated
```

---

## How to Use the Checklist

**The checklist is your step-by-step guide:**

1. Open `REFACTORING_PHASE1_CHECKLIST.md`
2. Start with "Move 1A"
3. Follow each numbered step exactly
4. Run the verification commands as specified
5. Commit when indicated
6. Move to next step
7. At the end, you'll have Move 1E complete

**Example:**
```markdown
## Move 1A: db → data ⏱️ 1-2 hours

### Step 1: Create target directory
### Step 2: Move files
### Step 3: Update imports
### Step 4: Verify build
### Step 5: Run tests
### Step 6: Commit
### Step 7: Tag
```

**Timeline recommendation:**
- **Day 1 morning:** Moves 1A and 1B (2 hours)
- **Day 1 afternoon:** Moves 1C, 1D, 1E (5 hours) ← 1D is the heavy one
- **End of Day 1:** Full test suite passes, ready for Phase 2

---

## After Phase 1: What's Next

Once Phase 1 is complete (all directories moved, tests passing):

### Phase 2: Service Standardization (8-13 hours)

Standardize 5 priority services:
1. **EC2** (3-4 hours) - largest, most operations, most tests
2. **Lambda** (2-3 hours) - complex, VPC integration
3. **IAM** (2 hours)
4. **S3** (1.5 hours)
5. **KMS** (1.5 hours)

**For each service:**
- Create uniform directory structure
- Add README.md with:
  - Implemented operations (with LOC, test count)
  - Not-implemented operations (with priority)
  - Example usage
- Standardize handler patterns
- Update all tests
- Verify Terraform scenarios still pass

### Phase 3: Remaining Services (8-12 hours)

Apply same standardization to 7 remaining services:
- SSM, CloudFormation, Organizations, Logs, EFS, Service Quotas, STS, CloudTrail

Can be done in parallel or sequentially.

### Phase 4: Integration Testing (4-6 hours)

Establish rigorous testing practices:
- Terraform test suite for all services
- Network evidence regression tests
- Cross-service scenarios (EC2+Lambda+S3, etc.)
- Performance baseline

---

## Starting Now

### Prerequisites

You have:
- ✅ All 91 tests currently passing
- ✅ Clean build
- ✅ Git repo with full history
- ✅ No uncommitted changes
- ✅ Terraform test infrastructure
- ✅ Network evidence validation

### Ready Checks

Before starting Move 1A:

```bash
# 1. Current branch is main
git status  # Should be clean

# 2. All tests pass
npm test 2>&1 | tail -5
# Should show: "Tests: XXX passed, XXX total"

# 3. Build is clean
npm run build 2>&1 | tail -3
# Should show: no errors

# 4. Current directory structure is as expected
ls -la src/app/api/
# Should show: db/, network/, policy/, resources/, runtime/
```

### Start Command

```bash
# Open the checklist
open docs/REFACTORING_PHASE1_CHECKLIST.md

# Or view it:
cat docs/REFACTORING_PHASE1_CHECKLIST.md

# Begin with Move 1A step 1:
# mkdir -p src/app/data
```

---

## Risk Mitigation

### If Something Goes Wrong

**Each move is tagged for instant rollback:**

```bash
# See all tags
git tag -l | grep refactor

# Rollback to previous move
git reset --hard refactor-phase-1c-complete

# Identify and fix the issue in your local changes
# Then recommit
```

### What Could Go Wrong

1. **Import path typos**
   - Detection: Build fails immediately
   - Fix: Check import paths, correct them, rebuild

2. **Missed imports**
   - Detection: Tests fail with "cannot find module"
   - Fix: Search for that path, update all files

3. **Network evidence changes**
   - Detection: Evidence tests show different output
   - Fix: Check reach.ts, trace.ts for accidental changes
   - Rollback: `git reset --hard refactor-phase-1d-start`

4. **Terraform tests fail**
   - Detection: `terraform test` fails
   - Fix: Check that network import paths are correct

**Strategy:**
- Run tests after each move
- Commit after each move succeeds
- If a move fails, rollback immediately
- Identify issue, fix it locally, recommit
- Never skip a step
- Don't fix multiple moves at once

---

## Success Criteria

Phase 1 is complete when:

- [x] Move 1A done, tests pass
- [x] Move 1B done, tests pass
- [x] Move 1C done, tests pass
- [x] Move 1D done, tests pass, evidence unchanged
- [x] Move 1E done, tests pass
- [x] Full test suite: all 91 tests pass
- [x] Build: clean, no errors
- [x] Git history: 5 clean commits with tags
- [x] Terraform: integration tests pass
- [x] Network evidence: same format, same kinds

---

## Questions?

### "Why move network to analysis, not app/network?"
**Answer:** Services (app/api/) should only contain HTTP handlers and business logic. Network analysis is a shared capability used by many services to answer "can packets flow?" That's query/analysis work, not API work. Just like database queries live in a data layer.

### "Can I do moves in parallel?"
**Answer:** No. They have dependencies (e.g., 1A changes import paths that 1B also uses). Do them in order: 1A → 1B → 1C → 1D → 1E.

### "What if a move takes longer than estimated?"
**Answer:** No problem. Estimates are best-case with no interruptions. Take your time, follow the checklist step-by-step. The exact time doesn't matter; getting it right does.

### "Can I skip Move 1C because policy is small?"
**Answer:** No. The point is clean separation. You might think "policy is small" but it touches every service's authorization. Moving it now saves confusion later.

### "Do I need to understand all of REFACTORING_PLAN.md?"
**Answer:** You only need the checklist to execute. Keep REFACTORING_PLAN.md open for reference if you have questions about why something is being moved, but the checklist has all the commands.

### "What happens to old import paths after moves?"
**Answer:** They won't work. That's the point. Tests will fail immediately, telling you which files to fix. Then you update those import paths.

---

## Next Session

When you're ready to start:

1. ✅ Make sure everything is committed (git status clean)
2. ✅ Verify tests pass (npm test)
3. ✅ Verify build passes (npm run build)
4. ✅ Open `REFACTORING_PHASE1_CHECKLIST.md`
5. ✅ Start with Move 1A, Step 1
6. ✅ Follow each step in order
7. ✅ Commit after each move
8. ✅ Tag after each commit

**Estimated session time: 5-7 hours for Phase 1**

After Phase 1, you'll have:
- Clean directory structure
- Clear separation of concerns
- Foundation for Phase 2 (service standardization)
- All tests still passing
- All git history preserved

Then Phase 2 (standardize services), then Phase 3 (remaining services), then Phase 4 (integration testing).

---

## Files to Keep Handy

```
docs/REFACTORING_PHASE1_CHECKLIST.md     ← This is your command reference
docs/REFACTORING_PLAN.md                  ← This is full context (if you need it)
```

---

## You're Ready

All the planning is done. All the commands are written. All the steps are laid out.

**Ready to start? Begin with Move 1A.**

```bash
mkdir -p src/app/data
mv src/app/api/db/* src/app/data/
# ... continue with checklist
```

Good luck! The refactoring is ahead of you—a clear, structured path with no unknowns.

If you get stuck on any step, all the context is in the documents.
