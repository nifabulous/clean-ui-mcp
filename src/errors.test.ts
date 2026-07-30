import { describe, it, expect } from "vitest";
import { describeError } from "./errors.js";

const PATH_SHAPED = /(?:^|[\s'"(=])\/(?:Users|private|var|tmp|home)\//;

function errnoError(code: string, path: string): NodeJS.ErrnoException {
  const e = new Error(`${code}: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
  e.code = code;
  e.path = path;
  return e;
}

describe("describeError", () => {
  it("renders an errno error as name + code, never the message or path", () => {
    const e = errnoError("ENOENT", "/Users/secret/corpus/images-private/shot.png");
    const out = describeError(e);
    expect(out).toBe("Error: ENOENT");
    expect(out).not.toContain(e.path!);
    expect(out).not.toContain(e.message);
    expect(out).not.toMatch(PATH_SHAPED);
  });

  it("keeps a real error's constructor name", () => {
    expect(describeError(new TypeError("boom"))).toBe("TypeError");
  });

  it("tolerates a non-Error throw without leaking it", () => {
    expect(describeError({ path: "/Users/secret/x" })).toBe("non-error (object)");
    expect(describeError("/private/var/secret/y")).not.toMatch(PATH_SHAPED);
    expect(describeError(42)).toBe("non-error (number)");
  });

  it("drops a path smuggled through name or code (with separators)", () => {
    const crafted = Object.assign(new Error("boom"), {
      name: "/Users/secret/named",
      code: "/private/var/secret/code",
    });
    expect(describeError(crafted)).toBe("Error");
  });

  it("drops a separator-free but off-shape name/code (e.g. a bare filename)", () => {
    const crafted = Object.assign(new Error("boom"), { name: "secret.png", code: "leak.png" });
    const out = describeError(crafted);
    expect(out).toBe("Error"); // name off-shape → "Error"; code off-shape → dropped
    expect(out).not.toContain("secret");
    expect(out).not.toContain("leak");
  });

  it("accepts genuine Node error codes (errno and ERR_*)", () => {
    expect(describeError(errnoError("EACCES", "/tmp/x"))).toBe("Error: EACCES");
    const codeErr = Object.assign(new Error("bad arg"), { code: "ERR_INVALID_ARG_TYPE" });
    expect(describeError(codeErr)).toBe("Error: ERR_INVALID_ARG_TYPE");
  });
});
