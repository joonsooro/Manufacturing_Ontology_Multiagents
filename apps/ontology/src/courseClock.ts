/**
 * Server clock override for the course dataset.
 * Only implicit current time is shifted; explicitly supplied dates retain their meaning.
 */
/**
 * Anchors server time at COURSE_NOW while retaining normal elapsed time.
 * Import this module once during startup, before the server begins listening.
 */
const courseNow = process.env.COURSE_NOW

if (!courseNow) {
  throw new Error('COURSE_NOW must be set')
}

const anchorTime = Date.parse(courseNow)
if (Number.isNaN(anchorTime)) {
  throw new Error(`COURSE_NOW is not a valid date: ${courseNow}`)
}

// Keep the original constructor so elapsed-time calculation does not call the patched Date recursively.
const NativeDate = Date
const processStartedAt = NativeDate.now()
const anchoredNow = () => anchorTime + (NativeDate.now() - processStartedAt)

class CourseDate extends NativeDate {
  constructor(...args: any[]) {
    if (args.length === 0) {
      super(anchoredNow())
    } else {
      // Preserve every native Date constructor overload when a caller supplies explicit date arguments.
      switch (args.length) {
        case 1: super(args[0]); break
        case 2: super(args[0], args[1]); break
        case 3: super(args[0], args[1], args[2]); break
        case 4: super(args[0], args[1], args[2], args[3]); break
        case 5: super(args[0], args[1], args[2], args[3], args[4]); break
        case 6: super(args[0], args[1], args[2], args[3], args[4], args[5]); break
        default: super(args[0], args[1], args[2], args[3], args[4], args[5], args[6])
      }
    }
  }

  static now(): number {
    return anchoredNow()
  }
}

// This process-wide override makes new Date() and Date.now() agree across all server handlers.
globalThis.Date = CourseDate as unknown as DateConstructor
