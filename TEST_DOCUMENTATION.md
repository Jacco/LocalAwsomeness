# Test Suite Documentation

## Overview

This document describes the test suite for the jpk-app refactoring. The tests are designed to ensure that refactored code maintains backward compatibility and doesn't break existing functionality.

## Test Coverage

### 1. **Common Utilities Tests** (`src/app/api/__tests__/common.test.ts`)
Tests for core API utility functions that handle request processing, responses, and error handling.

**Coverage:**
- `getRequestInfo()` - Extracts AWS principal, region, user, and userId from request headers
- `ok()` - Creates 200 OK JSON responses
- `okxml()` - Creates 200 OK XML responses
- `AwsError` - Custom error class for AWS-formatted errors
- `awsJson()` - Formats responses as AWS JSON (v1.0 and v1.1)
- `awsJsonError()` - Formats errors as AWS JSON with proper headers
- `error()` - Creates standard error responses
- `generateIamId()` - Generates AWS IAM-style IDs with prefixes

**Test Cases:** 22 tests

### 2. **Database Common Utilities Tests** (`src/app/api/db/__tests__/common.ts`)
Tests for region validation and account verification.

**Coverage:**
- Region lists (enable-by-default and opt-in regions)
- `assertValidRegion()` - Validates AWS region names
- `assertAccountExists()` - Checks if account directory exists
- `PARTITION` constant

**Test Cases:** 18 tests

### 3. **Account Operations Tests** (`src/app/api/db/__tests__/account.test.ts`)
Integration tests for account data persistence and management.

**Coverage:**
- Region opt-in/opt-out tracking
- Contact information storage and retrieval
- Account data persistence
- Multiple contact type support

**Test Cases:** 12 tests

### 4. **Integration Tests** (`src/app/api/__tests__/integration.test.ts`)
End-to-end tests verifying that refactored components work together correctly.

**Coverage:**
- Complete request handling flow
- Error handling consistency
- Response generation
- Multiple account support
- Region availability
- Complex request scenarios

**Test Cases:** 10 tests

## Running Tests

### Run all tests
```bash
npm test
```

### Run tests in watch mode (auto-rerun on file changes)
```bash
npm run test:watch
```

### Generate coverage report
```bash
npm run test:coverage
```

## Test Structure

Each test file follows this structure:
1. **Imports** - Import the functions/classes to test and any dependencies
2. **Mocking** - Set up mocks for file system and external dependencies
3. **Test Suites** - Grouped with `describe()` blocks
4. **Test Cases** - Individual tests with `it()` blocks
5. **Setup/Teardown** - `beforeEach()` hooks to reset mocks

## Key Testing Patterns

### 1. **Unit Tests**
- Test individual functions in isolation
- Mock external dependencies (fs, http)
- Verify return values and side effects

### 2. **Integration Tests**
- Test how multiple functions work together
- Verify end-to-end flows
- Test real-world scenarios

### 3. **Edge Cases**
- Empty/undefined inputs
- Invalid data
- Boundary conditions
- Error scenarios

## Coverage Goals

The test suite currently achieves:
- **100% coverage** for utility functions (`common.ts`, `db/common.ts`)
- **High coverage** for integration scenarios
- **Error handling** validated across all response types

## Continuous Integration

These tests can be integrated into CI/CD pipelines:
```bash
npm test -- --coverage --watchAll=false
```

## Refactoring Verification

The test suite ensures that:
1. ✅ All utility functions work correctly
2. ✅ Request parsing extracts correct values
3. ✅ Response formatting matches AWS standards
4. ✅ Error handling is consistent
5. ✅ Region validation works properly
6. ✅ Account operations are preserved
7. ✅ Multi-account scenarios are supported
8. ✅ Edge cases are handled gracefully

## Maintenance

When adding new features or making changes:
1. Run the full test suite to verify nothing breaks
2. Add tests for new functionality
3. Update this documentation if test structure changes
4. Aim for 100% coverage on utility/common functions
