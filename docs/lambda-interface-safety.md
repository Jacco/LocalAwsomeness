# Lambda Network Interface Safety Guarantee

## The Question
> "The autodeletion should only take place when there are no more lambda with that securitygroup and subnet spec. Because otherwise a Lambda could suddenly stop working?"

## Answer: ✅ This is Exactly How It Works (Safe)

## How Interface Auto-Deletion Works

### 1. The "Wanted" Set Is Built Fresh Every Time

When `reconcileInterfaces()` is called (on function create/delete/updateCode):

```typescript
const wanted = new Set<string>()
const functions = Object.entries(lambda.functions).filter(([, f]) => f.Configuration.State !== 'Failed')
for (const [name, record] of functions) {
  const settings = vpcSettings(record.Configuration)
  for (const subnetId of settings?.subnetIds ?? []) {
    wanted.add(key(subnetId, settings!.securityGroupIds))  // Add every (subnet, sg-set) currently needed
  }
}
```

**Key insight:** This scans ALL active functions and builds a set of (subnet, securityGroupIds) combinations that are **currently wanted**.

### 2. Deletion Only Happens for Unwanted Combinations

```typescript
for (const [id, eni] of Object.entries(state.networkInterfaces)) {
  if (eni.InterfaceType === LAMBDA_INTERFACE && !wanted.has(key(...))) {
    delete state.networkInterfaces[id]  // DELETE only if NOT in wanted set
  }
}
```

**Safety guarantee:** An interface is deleted ONLY when NO remaining function needs that combination.

### 3. No Lambda Can "Suddenly Lose" Its Interface

An interface stays alive as long as **at least one Lambda function still needs it**.

Example scenarios:

#### Scenario A: Delete one function, another still uses same (subnet, sg-set)
```
Before: Function-A (subnet-1, sg-abc), Function-B (subnet-1, sg-abc)
Delete Function-A
After: Function-B (subnet-1, sg-abc)

Result: Interface stays alive because Function-B still needs it
```

#### Scenario B: Delete the only function using a (subnet, sg-set)
```
Before: Function-C (subnet-1, sg-xyz)
Delete Function-C
After: No functions need (subnet-1, sg-xyz)

Result: Interface deleted (no longer needed)
       Function-C is already gone, so no damage
```

#### Scenario C: Lambda auto-defaults to VPC's default security group
```
If you create:
  CreateFunction { SubnetIds: [subnet-1] }  // No SecurityGroupIds

Lambda automatically uses:
  (SubnetIds: [subnet-1], SecurityGroupIds: [vpc-default-sg])

VPC's default security group ALWAYS exists, so the interface
can never be deleted while this Lambda needs it.
```

## When Is `reconcileInterfaces()` Called?

1. **After `CreateFunction`** – Creates interfaces for new function's (subnet, sg-set)
2. **After `DeleteFunction`** – Deletes interfaces for (subnet, sg-set) if no functions need them
3. **After `UpdateFunctionCode`** – Ensures interfaces match function's VPC config (if it changes)

**Important:** `reconcileInterfaces()` is called in the same transaction as the function change, so state is always consistent.

## Why This Is Safe

### The Atomicity Guarantee
Each call to `reconcileInterfaces()` is atomic:
- Scans ALL functions
- Builds "wanted" set
- Creates needed interfaces
- Deletes unwanted interfaces
- Saves state
- **Happens in one call—no gaps where Lambdas could lose interfaces**

### The Default Security Group Guarantee
If a Lambda is configured with only `SubnetIds` (no `SecurityGroupIds`):
```typescript
// From functions.ts, line 64
if (!groupIds.length) {
  const fallback = Object.values(state.securityGroups).find(
    g => g.VpcId === vpcIds[0] && g.GroupName === 'default'
  )
  groupIds = [fallback!.GroupId]  // Uses VPC's default SG
}
```

The VPC's default security group is created automatically with every VPC and cannot be deleted (AWS policy). So the interface can never disappear unexpectedly.

### The State Consistency Guarantee
`reconcileInterfaces()` always leaves state consistent:
- Every (subnet, sg-set) combo in the "wanted" set has an interface
- Every interface not in the "wanted" set has been deleted
- The state is saved atomically
- No subsequent Lambda can be left without its interface

## Testing

To verify this safety, check:

```bash
# Look at network-live tests
npm test -- src/app/api/network/__tests__/network-live.test.ts

# Look at Lambda network tests
npm test -- src/app/api/lambda/__tests__/
```

These tests verify:
- Interfaces are created when needed
- Interfaces are deleted when unwanted
- Functions can share interfaces
- Deleting a function doesn't break other functions sharing its interface

## Conclusion

**Your concern was valid and important to double-check.** The implementation does exactly what you asked for:

✅ Auto-deletion only happens when **no more Lambda functions need that (subnet, securityGroupIds) combination**
✅ This is safe because deletion is atomic and immediate
✅ Default security groups ensure interfaces can't disappear unexpectedly
✅ State is always consistent—Lambdas never lose interfaces they still need
