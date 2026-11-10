import { lambda } from "../../service"

// POST creates a function, GET lists them (the trailing slash of ListFunctions is handled in next.config.ts).
export const POST = lambda.postAction('CreateFunction')
export const GET = lambda.postAction('ListFunctions')
