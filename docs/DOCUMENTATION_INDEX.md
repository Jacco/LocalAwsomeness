# Documentation Index: Logging, Permissions, and Limitations

## Quick Answers

**Q: Does the simulator check CloudWatch logging permissions?**  
A: Yes. See [logging-permissions-clarification.md](./logging-permissions-clarification.md).

**Q: Can I use `socket.gethostbyname()` in Lambda code?**  
A: No. Socket-level DNS won't be intercepted. Use boto3/requests/urllib instead. See [lambda-user-guide.md](./lambda-user-guide.md).

**Q: Why does netshim.py exist and how does it work?**  
A: It intercepts HTTP library calls and routes them through the network model. See [logging-architecture-decision.md](./logging-architecture-decision.md).

**Q: When will DNS resolution work for all code?**  
A: Phase 3 or later. See [future-features.md](./future-features.md).

**Q: Will you implement CloudTrail?**  
A: Yes, a light version. See [future-features.md](./future-features.md).

---

## Documentation by Audience

### I'm Writing Lambda Code

Start here: **[lambda-user-guide.md](./lambda-user-guide.md)**
- Environment variables available to your code
- What code works (boto3, requests, urllib)
- What code doesn't work (socket DNS, low-level sockets)
- How logging and permissions work
- How to debug network errors
- Virtual time and retries

### I'm Debugging Network or Permission Issues

Start here: **[logging-permissions-clarification.md](./logging-permissions-clarification.md)**
- Do we check CloudWatch logging permissions? (Yes)
- How permissions are checked (post-facto, not a network call yet)
- How to tell if logging failed (check invocation record)
- Workaround: use the invocation record's `LogDelivery` field

### I'm Reviewing the Architecture

Start here: **[logging-architecture-decision.md](./logging-architecture-decision.md)**
- Real AWS logging behavior
- Current simulator logging model
- netshim.py design and limitations
- Why endpoint_url is wrong (and why the shim is right)
- Future improvements and their timeline
- Known gaps and when to fix them

### I'm Planning Future Work

Start here: **[future-features.md](./future-features.md)**
- DNS Server implementation (medium complexity, multi-language support)
- CloudTrail light version (low complexity, audit logging)
- Timing and dependencies for each feature
- Design sketches and complexity estimates

### I'm Adding Something to the Plan

See: **[roadmap.md](./roadmap.md)**
- All plans in one place, ordered by dependency
- New documentation files integrated into the table

---

## Related Technical Docs

- [lambda-plan.md](./lambda-plan.md) — Lambda design and implementation
- [lambda.md](../src/app/api/lambda/lambda.md) — Lambda API reference
- [logs.md](../src/app/api/logs/logs.md) — CloudWatch Logs service reference
- [network-connectivity-plan.md](./network-connectivity-plan.md) — VPC endpoints and advanced networking (future)
- [architecture.md](./architecture.md) — Overall system design

---

## Key Takeaways

1. **Logging is not yet a network call** — It's captured from stdout/stderr and written directly to CloudWatch state. This works for Phase 1 but will need to be fixed when VPC-attached Lambda without NAT/endpoint scenarios are tested.

2. **CloudWatch permissions ARE enforced** — A role without `logs:PutLogEvents` will not have its log written. The reason is reported in the invocation record.

3. **Socket DNS is not intercepted** — Code using `socket.gethostbyname()` or `socket.getaddrinfo()` will try to use the real system resolver. Users must use boto3, requests, or urllib.

4. **netshim.py is the right pattern** — It intercepts HTTP libraries (not sockets), keeps SigV4 signatures valid, and allows the network model to decide reachability. Don't patch boto3 with `endpoint_url`.

5. **DNS and CloudTrail are tracked** — Both features are documented with designs and are planned for future implementation.

---

## Document Status

| Document | Status | Audience | Key Message |
| --- | --- | --- | --- |
| lambda-user-guide.md | ✅ Complete | Users, testers | Here's what works and what doesn't |
| logging-architecture-decision.md | ✅ Complete | Architects, reviewers | Here's why it works this way, and what's missing |
| logging-permissions-clarification.md | ✅ Complete | Debuggers, role designers | Yes, we check permissions. No, not a network call yet. |
| future-features.md | ✅ Complete | Planners | DNS and CloudTrail are tracked and designed. |
| roadmap.md | ✅ Updated | Project managers | New docs integrated into the plan. |
