const [currentTag, previousTag = ""] = process.argv.slice(2);

if (!currentTag) {
  throw new Error(
    "Usage: compare-release-tags.mjs <current-tag> [previous-tag]"
  );
}

function parseStableTag(tag, label) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
  if (!match) {
    throw new Error(
      `${label} must be a stable vMAJOR.MINOR.PATCH tag; got ${tag}`
    );
  }

  return match.slice(1).map(BigInt);
}

const current = parseStableTag(currentTag, "Current package version");

if (!previousTag) {
  console.log("initial");
  process.exit(0);
}

const previous = parseStableTag(previousTag, "Latest release tag");

for (let index = 0; index < current.length; index += 1) {
  if (current[index] > previous[index]) {
    console.log("newer");
    process.exit(0);
  }
  if (current[index] < previous[index]) {
    console.log("older");
    process.exit(0);
  }
}

console.log("equal");
