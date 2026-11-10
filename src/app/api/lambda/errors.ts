import { AwsError } from "../common"

export const invalidParameter = (message: string) => new AwsError('InvalidParameterValueException', message, 400)
export const validation = (message: string) => new AwsError('ValidationException', message, 400)
