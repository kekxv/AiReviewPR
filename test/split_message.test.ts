// split_message.test.ts
import {doesAnyPatternMatch, split_message} from '../src/utils';

describe('split_message', () => {
  it('include readme.md', () => {
    const testString = `^.+\\.md
test2\\.js
dist/.*

  `;
    expect(doesAnyPatternMatch(split_message(testString), "readme.md")).toBe(true);
    expect(doesAnyPatternMatch(split_message(testString), "dist/index.js")).toBe(true);
    expect(doesAnyPatternMatch(split_message(testString), "dist/prompt.js")).toBe(true);
    expect(doesAnyPatternMatch(split_message(testString), "src/index.js")).toBe(false);
  });
});

describe('split_message', () => {
  it('include readme.md', () => {
    const testString = `^.+\\.md
test2\\.js
dist/.*

  `;
    let file = "README.md";
    let include_files = split_message(testString);
    // console.log("check diff context:", file)
    expect(((include_files.length > 0) && (doesAnyPatternMatch(include_files, file)))).toBe(true);
  });
});
