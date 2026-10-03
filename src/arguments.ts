// NUL cannot occur in an OS argument, so normalized values cannot collide with user input.
const trailingArgumentPrefix = "\0"

export const normalizeTrailingArguments = (args: ReadonlyArray<string>): ReadonlyArray<string> => {
  const separator = args.indexOf("--")
  if (separator === -1) return args
  return [
    ...args.slice(0, separator),
    ...args.slice(separator + 1).map((value) => `${trailingArgumentPrefix}${Buffer.from(value).toString("base64url")}`),
  ]
}

export const decodeTrailingArguments = (values: ReadonlyArray<string>): ReadonlyArray<string> =>
  values.map((value) =>
    value.startsWith(trailingArgumentPrefix)
      ? Buffer.from(value.slice(trailingArgumentPrefix.length), "base64url").toString()
      : value,
  )
