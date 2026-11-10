import type { QueryHandler } from "../query"

// Placeholder: IAM users are not implemented yet, so this returns fixed sample users.
export const userHandlers: Record<string, QueryHandler> = {
  ListUsers() {
    return {
      Users: { member: [{ UserName: "Andrew" }, { UserName: "Jackie" }] },
      IsTruncated: false
    }
  }
}
