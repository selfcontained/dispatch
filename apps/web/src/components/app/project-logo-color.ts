const SAMPLE_SIZE = 48;

function relativeLuminance(rgb: number[]) {
  const [red, green, blue] = rgb.map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

function readableHex(rgb: number[]) {
  const luminance = relativeLuminance(rgb);
  // Keep very dark or light accents visible on the sidebar in either theme.
  const target = Math.max(0.15, Math.min(0.27, luminance));
  if (target !== luminance) {
    const endpoint = luminance < target ? 255 : 0;
    let lower = 0;
    let upper = 1;
    for (let step = 0; step < 8; step++) {
      const mix = (lower + upper) / 2;
      const adjusted = rgb.map(
        (channel) => channel + (endpoint - channel) * mix
      );
      const adjustedLuminance = relativeLuminance(adjusted);
      const needsMoreMix =
        endpoint === 255
          ? adjustedLuminance < target
          : adjustedLuminance > target;
      if (needsMoreMix) {
        lower = mix;
      } else {
        upper = mix;
      }
    }
    rgb = rgb.map((channel) => channel + (endpoint - channel) * upper);
  }
  return (
    "#" +
    rgb
      .map((channel) => Math.round(channel).toString(16).padStart(2, "0"))
      .join("")
  );
}

export function prominentLogoColors({ data, width, height }: ImageData) {
  const edgeColors = new Map<number, { offset: number; count: number }>();
  let edgeCount = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x !== 0 && x !== width - 1 && y !== 0 && y !== height - 1) continue;
      const offset = (y * width + x) * 4;
      edgeCount++;
      if (data[offset + 3]! < 240) continue;
      // Quantize the perimeter to detect a flat, opaque background.
      const key =
        ((data[offset]! >> 4) << 8) |
        ((data[offset + 1]! >> 4) << 4) |
        (data[offset + 2]! >> 4);
      const bucket = edgeColors.get(key) ?? { offset, count: 0 };
      bucket.count++;
      edgeColors.set(key, bucket);
    }
  }

  const edge = [...edgeColors.values()].find(
    ({ count }) => count > edgeCount * 0.6
  );
  const matchesEdge = (offset: number) =>
    edge !== undefined &&
    data[offset + 3]! >= 240 &&
    [0, 1, 2].every(
      (channel) =>
        Math.abs(data[offset + channel]! - data[edge.offset + channel]!) < 24
    );

  let ignoreEdge = false;
  if (edge) {
    for (let offset = 0; offset < data.length; offset += 4) {
      if (data[offset + 3]! >= 128 && !matchesEdge(offset)) {
        ignoreEdge = true;
        break;
      }
    }
  }

  const hues = Array.from({ length: 24 }, () => ({
    weight: 0,
    rgb: [0, 0, 0],
  }));
  for (let offset = 0; offset < data.length; offset += 4) {
    const red = data[offset]!;
    const green = data[offset + 1]!;
    const blue = data[offset + 2]!;
    const alpha = data[offset + 3]!;
    if (alpha < 128 || (ignoreEdge && matchesEdge(offset))) continue;
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const chroma = max - min;
    if (max < 48 || min > 224 || chroma < 40 || chroma / max < 0.25) continue;

    const hue =
      max === red
        ? (green - blue) / chroma
        : max === green
          ? 2 + (blue - red) / chroma
          : 4 + (red - green) / chroma;
    const bucket = hues[(Math.round(hue * 4) + hues.length) % hues.length]!;
    bucket.weight += alpha;
    bucket.rgb[0]! += red * alpha;
    bucket.rgb[1]! += green * alpha;
    bucket.rgb[2]! += blue * alpha;
  }

  const ranked = hues
    .map((bucket, hue) => ({ ...bucket, hue }))
    .sort((a, b) => b.weight - a.weight);
  const minimumWeight = Math.max(1, ranked[0]!.weight * 0.02);
  const selectedHues: number[] = [];
  const colors: string[] = [];
  for (const bucket of ranked) {
    if (bucket.weight < minimumWeight || colors.length === 3) break;
    // Adjacent buckets can represent shades of the same color, including red
    // on either side of the hue wheel's wraparound.
    if (
      selectedHues.some((hue) => {
        const distance = Math.abs(hue - bucket.hue);
        return Math.min(distance, hues.length - distance) <= 1;
      })
    )
      continue;
    const color = readableHex(bucket.rgb.map((sum) => sum / bucket.weight));
    if (colors.includes(color)) continue;
    selectedHues.push(bucket.hue);
    colors.push(color);
  }
  return colors;
}

export function readProjectLogoColors(img: HTMLImageElement) {
  const longestSide = Math.max(img.naturalWidth, img.naturalHeight);
  if (longestSide === 0) return [];
  const scale = Math.min(1, SAMPLE_SIZE / longestSide);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const context = canvas.getContext("2d");
  if (!context) return [];
  try {
    context.drawImage(img, 0, 0, canvas.width, canvas.height);
    return prominentLogoColors(
      context.getImageData(0, 0, canvas.width, canvas.height)
    );
  } catch {
    return [];
  }
}
