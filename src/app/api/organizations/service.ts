import { JsonProtocol } from "../protocols"
import { defineService } from "../registry"
import { handlers } from "./handlers"

export const organizations = defineService({
  iamPrefix: 'organizations',
  protocol: new JsonProtocol('1.1', 'InvalidInputException'),
  operations: handlers
})
