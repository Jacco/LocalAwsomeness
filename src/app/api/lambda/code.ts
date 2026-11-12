import { mkdirSync, writeFileSync } from "fs"
import { dirname, join, resolve } from "path"
import { AwsError } from "../common"
import * as store from "../data/store"
import { QUOTAS, hardLimit } from "../quotas"
import { invalidParameter } from "./errors"
import { readZip, ZipError, type ZipEntry } from "./zip"

// The code of a function is kept as the files it consists of, not as the zip it was uploaded as:
//   db/<account>/<region>/lambda-code/<function>/index.py, lib/helper.py, ...
// so it can be read (and, for a manual experiment, edited) like the code in /var/task. The zip is read once, on upload;
// the code size and hash that GetFunction reports are those of the upload.

interface Scope {
  account: string
  region: string
}

// Absolute: the function runs in a working directory of its own, where a relative database path would not resolve.
export const codeDirectory = ({ account, region }: Scope, name: string) => resolve(store.directoryPath({ service: 'lambda-code', account, region }, name))

// What an upload of a zip comes to, or the error AWS gives for a package it cannot unpack.
export function unpack(zip: Buffer): ZipEntry[] {
  if (zip.length < 4) {
    throw invalidParameter('Could not unzip uploaded file. Please check your file, then try to upload again.')
  }
  try {
    return readZip(zip, { maxUnzippedBytes: hardLimit(QUOTAS.lambdaPackageUnzippedSize) })
  } catch (error) {
    if (error instanceof ZipError) {
      const tooBig = /unzipped size exceeds/.test(error.message)
      if (tooBig) {
        throw new AwsError('InvalidParameterValueException', `Unzipped size must be smaller than ${hardLimit(QUOTAS.lambdaPackageUnzippedSize)} bytes`, 400)
      }
      throw invalidParameter('Could not unzip uploaded file. Please check your file, then try to upload again.')
    }
    throw error
  }
}

// Replaces the code of a function: the old files are removed first, so nothing of an earlier version stays behind.
export function writeCode(scope: Scope, name: string, files: ZipEntry[]): void {
  const directory = codeDirectory(scope, name)
  store.removeDirectory(directory)
  mkdirSync(directory, { recursive: true })
  for (const file of files) {
    const target = join(directory, file.name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.data)
  }
}

export const removeCode = (scope: Scope, name: string) => store.removeDirectory(codeDirectory(scope, name))
