import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  imageDimensionsFromBuffer,
  probeImageFile,
} from "../src/media/image-dimensions.js";

/**
 * Real encoder output, not hand-built headers: each buffer below came out of
 * an encoder at the dimensions its name states. A parser that only ever sees
 * bytes we wrote ourselves proves nothing about the files agents upload.
 */
const PNG_37x19 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAACUAAAATCAIAAACY31PkAAAACXBIWXMAAAPoAAAD6AG1" +
    "e1JrAAAALElEQVR4nGM4EaBBT8Qwal/AaHieGE0vGqP54cRo+aIxWn4GjNYPGsOnvgUA" +
    "48pu7rw5XfcAAAAASUVORK5CYII=",
  "base64"
);

const JPEG_64x41 = Buffer.from(
  "/9j/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEi" +
    "MEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7" +
    "Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAApAEADASIA" +
    "AhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA" +
    "/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMB" +
    "AAIRAxEAPwCEBPrIAAAAAAAAAAAAAAAAAAAAAB//2Q==",
  "base64"
);

const GIF_23x71 = Buffer.from(
  "R0lGODlhFwBHAIAAAExpcchQKCH5BAUAAAAALAAAAAAXAEcAAAInjI+py+0Po5y02ouz" +
    "3rz7D4biSJbmiabqyrbuC8fyTNf2jef6zqcFADs=",
  "base64"
);

const WEBP_LOSSY_52x29 = Buffer.from(
  "UklGRkoAAABXRUJQVlA4ID4AAACQAwCdASo0AB0APm02mEkkIyKhJAgAgA2JZwB2APwA" +
    "AEnCt77QAP7kAX//5BcsLrka//+hJ+CT8En7gAAAAA==",
  "base64"
);

const WEBP_LOSSLESS_17x83 = Buffer.from(
  "UklGRiQAAABXRUJQVlA4TBcAAAAvEIAUAAdQqCIXpf8BICH8P69G9D+9AQA=",
  "base64"
);

const JPEG_EXIF_120x90 = Buffer.from(
  "/9j/4QJaRXhpZgAASUkqAAgAAAAHABIBAwABAAAAAQAAABoBBQABAAAAYgAAABsBBQAB" +
    "AAAAagAAACgBAwABAAAAAgAAABMCAwABAAAAAQAAAJiCAgCRAQAAcgAAAGmHBAABAAAA" +
    "BAIAAAAAAAA4YwAA6AMAADhjAADoAwAAeHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4" +
    "eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4" +
    "eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4" +
    "eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4" +
    "eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4" +
    "eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4" +
    "eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4" +
    "eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4" +
    "eHh4eHh4eHh4eHh4eHh4eAAABgAAkAcABAAAADAyMTABkQcABAAAAAECAwAAoAcABAAA" +
    "ADAxMDABoAMAAQAAAP//AAACoAQAAQAAAHgAAAADoAQAAQAAAFoAAAAAAAAA/+IB8ElD" +
    "Q19QUk9GSUxFAAEBAAAB4GxjbXMEIAAAbW50clJHQiBYWVogB+IAAwAUAAkADgAdYWNz" +
    "cE1TRlQAAAAAc2F3c2N0cmwAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1oYW5keem/Vlo+" +
    "AbaDI4VVRvdPqgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKZGVzYwAAAPwA" +
    "AAAkY3BydAAAASAAAAAid3RwdAAAAUQAAAAUY2hhZAAAAVgAAAAsclhZWgAAAYQAAAAU" +
    "Z1hZWgAAAZgAAAAUYlhZWgAAAawAAAAUclRSQwAAAcAAAAAgZ1RSQwAAAcAAAAAgYlRS" +
    "QwAAAcAAAAAgbWx1YwAAAAAAAAABAAAADGVuVVMAAAAIAAAAHABzAFIARwBCbWx1YwAA" +
    "AAAAAAABAAAADGVuVVMAAAAGAAAAHABDAEMAMAAAWFlaIAAAAAAAAPbWAAEAAAAA0y1z" +
    "ZjMyAAAAAAABDD8AAAXd///zJgAAB5AAAP2S///7of///aIAAAPcAADAcVhZWiAAAAAA" +
    "AABvoAAAOPIAAAOPWFlaIAAAAAAAAGKWAAC3iQAAGNpYWVogAAAAAAAAJKAAAA+FAAC2" +
    "xHBhcmEAAAAAAAMAAAACZmkAAPKnAAANWQAAE9AAAApb/9sAQwAGBAUGBQQGBgUGBwcG" +
    "CAoQCgoJCQoUDg8MEBcUGBgXFBYWGh0lHxobIxwWFiAsICMmJykqKRkfLTAtKDAlKCko" +
    "/9sAQwEHBwcKCAoTCgoTKBoWGigoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo" +
    "KCgoKCgoKCgoKCgoKCgoKCgo/8AAEQgAWgB4AwEiAAIRAQMRAf/EABUAAQEAAAAAAAAA" +
    "AAAAAAAAAAAF/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/EABYBAQEBAAAAAAAAAAAAAAAA" +
    "AAAGB//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJACRaQAAAAAAAAA" +
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
    "AAAAAAAAAAAAAAAAA//Z",
  "base64"
);

const WEBP_VP8X_96x31 = Buffer.from(
  "UklGRmwAAABXRUJQVlA4WAoAAAAQAAAAXwAAHgAAQUxQSBAAAAABB1DAiAgACeH/ejGi" +
    "/6kcVlA4IDYAAABQAwCdASpgAB8APm02mEkkIyKhIqgAgA2JaQAAE/GOKXzZYAD++iGX" +
    "zse4P+g+GifAJ+AAAAA=",
  "base64"
);

/**
 * The same 120x90 JPEG carrying each EXIF orientation, pixels unrotated —
 * what a phone camera writes. Orientations 6 and 8 include a quarter turn, so
 * a browser decodes them as 90x120.
 */
const JPEG_ORIENT_1_120x90 = Buffer.from(
  "/9j/4QC8RXhpZgAASUkqAAgAAAAGABIBAwABAAAAAQAAABoBBQABAAAAVgAAABsBBQAB" +
    "AAAAXgAAACgBAwABAAAAAgAAABMCAwABAAAAAQAAAGmHBAABAAAAZgAAAAAAAAA4YwAA" +
    "6AMAADhjAADoAwAABgAAkAcABAAAADAyMTABkQcABAAAAAECAwAAoAcABAAAADAxMDAB" +
    "oAMAAQAAAP//AAACoAQAAQAAAHgAAAADoAQAAQAAAFoAAAAAAAAA/+IB8ElDQ19QUk9G" +
    "SUxFAAEBAAAB4GxjbXMEIAAAbW50clJHQiBYWVogB+IAAwAUAAkADgAdYWNzcE1TRlQA" +
    "AAAAc2F3c2N0cmwAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1oYW5keem/Vlo+AbaDI4VV" +
    "RvdPqgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKZGVzYwAAAPwAAAAkY3By" +
    "dAAAASAAAAAid3RwdAAAAUQAAAAUY2hhZAAAAVgAAAAsclhZWgAAAYQAAAAUZ1hZWgAA" +
    "AZgAAAAUYlhZWgAAAawAAAAUclRSQwAAAcAAAAAgZ1RSQwAAAcAAAAAgYlRSQwAAAcAA" +
    "AAAgbWx1YwAAAAAAAAABAAAADGVuVVMAAAAIAAAAHABzAFIARwBCbWx1YwAAAAAAAAAB" +
    "AAAADGVuVVMAAAAGAAAAHABDAEMAMAAAWFlaIAAAAAAAAPbWAAEAAAAA0y1zZjMyAAAA" +
    "AAABDD8AAAXd///zJgAAB5AAAP2S///7of///aIAAAPcAADAcVhZWiAAAAAAAABvoAAA" +
    "OPIAAAOPWFlaIAAAAAAAAGKWAAC3iQAAGNpYWVogAAAAAAAAJKAAAA+FAAC2xHBhcmEA" +
    "AAAAAAMAAAACZmkAAPKnAAANWQAAE9AAAApb/9sAQwAGBAUGBQQGBgUGBwcGCAoQCgoJ" +
    "CQoUDg8MEBcUGBgXFBYWGh0lHxobIxwWFiAsICMmJykqKRkfLTAtKDAlKCko/9sAQwEH" +
    "BwcKCAoTCgoTKBoWGigoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo" +
    "KCgoKCgoKCgoKCgo/8AAEQgAWgB4AwEiAAIRAQMRAf/EABUAAQEAAAAAAAAAAAAAAAAA" +
    "AAAG/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/EABYBAQEBAAAAAAAAAAAAAAAAAAAFB//E" +
    "ABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJwBEagAAAAAAAAAAAAAAAAA" +
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
    "AAAAAAAAA//Z",
  "base64"
);

const JPEG_ORIENT_3_120x90 = Buffer.from(
  "/9j/4QC8RXhpZgAASUkqAAgAAAAGABIBAwABAAAAAwAAABoBBQABAAAAVgAAABsBBQAB" +
    "AAAAXgAAACgBAwABAAAAAgAAABMCAwABAAAAAQAAAGmHBAABAAAAZgAAAAAAAAA4YwAA" +
    "6AMAADhjAADoAwAABgAAkAcABAAAADAyMTABkQcABAAAAAECAwAAoAcABAAAADAxMDAB" +
    "oAMAAQAAAP//AAACoAQAAQAAAHgAAAADoAQAAQAAAFoAAAAAAAAA/+IB8ElDQ19QUk9G" +
    "SUxFAAEBAAAB4GxjbXMEIAAAbW50clJHQiBYWVogB+IAAwAUAAkADgAdYWNzcE1TRlQA" +
    "AAAAc2F3c2N0cmwAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1oYW5keem/Vlo+AbaDI4VV" +
    "RvdPqgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKZGVzYwAAAPwAAAAkY3By" +
    "dAAAASAAAAAid3RwdAAAAUQAAAAUY2hhZAAAAVgAAAAsclhZWgAAAYQAAAAUZ1hZWgAA" +
    "AZgAAAAUYlhZWgAAAawAAAAUclRSQwAAAcAAAAAgZ1RSQwAAAcAAAAAgYlRSQwAAAcAA" +
    "AAAgbWx1YwAAAAAAAAABAAAADGVuVVMAAAAIAAAAHABzAFIARwBCbWx1YwAAAAAAAAAB" +
    "AAAADGVuVVMAAAAGAAAAHABDAEMAMAAAWFlaIAAAAAAAAPbWAAEAAAAA0y1zZjMyAAAA" +
    "AAABDD8AAAXd///zJgAAB5AAAP2S///7of///aIAAAPcAADAcVhZWiAAAAAAAABvoAAA" +
    "OPIAAAOPWFlaIAAAAAAAAGKWAAC3iQAAGNpYWVogAAAAAAAAJKAAAA+FAAC2xHBhcmEA" +
    "AAAAAAMAAAACZmkAAPKnAAANWQAAE9AAAApb/9sAQwAGBAUGBQQGBgUGBwcGCAoQCgoJ" +
    "CQoUDg8MEBcUGBgXFBYWGh0lHxobIxwWFiAsICMmJykqKRkfLTAtKDAlKCko/9sAQwEH" +
    "BwcKCAoTCgoTKBoWGigoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo" +
    "KCgoKCgoKCgoKCgo/8AAEQgAWgB4AwEiAAIRAQMRAf/EABUAAQEAAAAAAAAAAAAAAAAA" +
    "AAAG/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/EABYBAQEBAAAAAAAAAAAAAAAAAAAFB//E" +
    "ABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJwBEagAAAAAAAAAAAAAAAAA" +
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
    "AAAAAAAAA//Z",
  "base64"
);

const JPEG_ORIENT_6_120x90 = Buffer.from(
  "/9j/4QC8RXhpZgAASUkqAAgAAAAGABIBAwABAAAABgAAABoBBQABAAAAVgAAABsBBQAB" +
    "AAAAXgAAACgBAwABAAAAAgAAABMCAwABAAAAAQAAAGmHBAABAAAAZgAAAAAAAAA4YwAA" +
    "6AMAADhjAADoAwAABgAAkAcABAAAADAyMTABkQcABAAAAAECAwAAoAcABAAAADAxMDAB" +
    "oAMAAQAAAP//AAACoAQAAQAAAHgAAAADoAQAAQAAAFoAAAAAAAAA/+IB8ElDQ19QUk9G" +
    "SUxFAAEBAAAB4GxjbXMEIAAAbW50clJHQiBYWVogB+IAAwAUAAkADgAdYWNzcE1TRlQA" +
    "AAAAc2F3c2N0cmwAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1oYW5keem/Vlo+AbaDI4VV" +
    "RvdPqgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKZGVzYwAAAPwAAAAkY3By" +
    "dAAAASAAAAAid3RwdAAAAUQAAAAUY2hhZAAAAVgAAAAsclhZWgAAAYQAAAAUZ1hZWgAA" +
    "AZgAAAAUYlhZWgAAAawAAAAUclRSQwAAAcAAAAAgZ1RSQwAAAcAAAAAgYlRSQwAAAcAA" +
    "AAAgbWx1YwAAAAAAAAABAAAADGVuVVMAAAAIAAAAHABzAFIARwBCbWx1YwAAAAAAAAAB" +
    "AAAADGVuVVMAAAAGAAAAHABDAEMAMAAAWFlaIAAAAAAAAPbWAAEAAAAA0y1zZjMyAAAA" +
    "AAABDD8AAAXd///zJgAAB5AAAP2S///7of///aIAAAPcAADAcVhZWiAAAAAAAABvoAAA" +
    "OPIAAAOPWFlaIAAAAAAAAGKWAAC3iQAAGNpYWVogAAAAAAAAJKAAAA+FAAC2xHBhcmEA" +
    "AAAAAAMAAAACZmkAAPKnAAANWQAAE9AAAApb/9sAQwAGBAUGBQQGBgUGBwcGCAoQCgoJ" +
    "CQoUDg8MEBcUGBgXFBYWGh0lHxobIxwWFiAsICMmJykqKRkfLTAtKDAlKCko/9sAQwEH" +
    "BwcKCAoTCgoTKBoWGigoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo" +
    "KCgoKCgoKCgoKCgo/8AAEQgAWgB4AwEiAAIRAQMRAf/EABUAAQEAAAAAAAAAAAAAAAAA" +
    "AAAG/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/EABYBAQEBAAAAAAAAAAAAAAAAAAAFB//E" +
    "ABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJwBEagAAAAAAAAAAAAAAAAA" +
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
    "AAAAAAAAA//Z",
  "base64"
);

const JPEG_ORIENT_8_120x90 = Buffer.from(
  "/9j/4QC8RXhpZgAASUkqAAgAAAAGABIBAwABAAAACAAAABoBBQABAAAAVgAAABsBBQAB" +
    "AAAAXgAAACgBAwABAAAAAgAAABMCAwABAAAAAQAAAGmHBAABAAAAZgAAAAAAAAA4YwAA" +
    "6AMAADhjAADoAwAABgAAkAcABAAAADAyMTABkQcABAAAAAECAwAAoAcABAAAADAxMDAB" +
    "oAMAAQAAAP//AAACoAQAAQAAAHgAAAADoAQAAQAAAFoAAAAAAAAA/+IB8ElDQ19QUk9G" +
    "SUxFAAEBAAAB4GxjbXMEIAAAbW50clJHQiBYWVogB+IAAwAUAAkADgAdYWNzcE1TRlQA" +
    "AAAAc2F3c2N0cmwAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y1oYW5keem/Vlo+AbaDI4VV" +
    "RvdPqgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAKZGVzYwAAAPwAAAAkY3By" +
    "dAAAASAAAAAid3RwdAAAAUQAAAAUY2hhZAAAAVgAAAAsclhZWgAAAYQAAAAUZ1hZWgAA" +
    "AZgAAAAUYlhZWgAAAawAAAAUclRSQwAAAcAAAAAgZ1RSQwAAAcAAAAAgYlRSQwAAAcAA" +
    "AAAgbWx1YwAAAAAAAAABAAAADGVuVVMAAAAIAAAAHABzAFIARwBCbWx1YwAAAAAAAAAB" +
    "AAAADGVuVVMAAAAGAAAAHABDAEMAMAAAWFlaIAAAAAAAAPbWAAEAAAAA0y1zZjMyAAAA" +
    "AAABDD8AAAXd///zJgAAB5AAAP2S///7of///aIAAAPcAADAcVhZWiAAAAAAAABvoAAA" +
    "OPIAAAOPWFlaIAAAAAAAAGKWAAC3iQAAGNpYWVogAAAAAAAAJKAAAA+FAAC2xHBhcmEA" +
    "AAAAAAMAAAACZmkAAPKnAAANWQAAE9AAAApb/9sAQwAGBAUGBQQGBgUGBwcGCAoQCgoJ" +
    "CQoUDg8MEBcUGBgXFBYWGh0lHxobIxwWFiAsICMmJykqKRkfLTAtKDAlKCko/9sAQwEH" +
    "BwcKCAoTCgoTKBoWGigoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo" +
    "KCgoKCgoKCgoKCgo/8AAEQgAWgB4AwEiAAIRAQMRAf/EABUAAQEAAAAAAAAAAAAAAAAA" +
    "AAAG/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/EABYBAQEBAAAAAAAAAAAAAAAAAAAFB//E" +
    "ABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJwBEagAAAAAAAAAAAAAAAAA" +
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
    "AAAAAAAAA//Z",
  "base64"
);

/**
 * Orientation carried by a PNG `eXIf` chunk, and the two JPEG layouts that
 * defeat a naive one-pass orientation read: a valid EXIF APP1 followed by an
 * XMP APP1, and an EXIF APP1 placed after the frame header. All 120x90 files;
 * Chromium lays the rotated ones out as 90x120.
 */
const PNG_EXIF_ORIENT_1_120x90 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAHgAAABaCAIAAAD8YgW4AAABP2lDQ1BpY2MAAHicfZC/" +
    "SwJxGMY/11WWWA05NBQcJU0FUUtTgYZOEfgj1Kbz/FGgdt33QprLoaloiEZrCaLZxhz6" +
    "A4KgIQqirdWghpKLrw5aUM/yfnh4Xt6XB5TnvFEQ3RoUirYVDvm1eCKpuV5Q8dLPIGO6" +
    "IczlSDAKIPSSMGwrzw+936PIeTe9rhfTO6/Xq8kFpbo7UY4FP1Yu+F/udEYYwBfgM0zL" +
    "BkUDxku2KXkJ8BrrehqUODBlxRNJUPakn2vxieRUiy8lW9FwAJQaoOU6ONXBhfy2vCsl" +
    "v/dkirEI0AeMIggTwv9HpreZCRBgBmRfv3sQ2bnZ1pZnEXqeHOdtElyH0DhynM9Tx2mc" +
    "gfoIta32/mYF5uugHrS91DFc7cPIQ9vzVWCoDNUbU7f0pqUCXdkNqJ/DQAKGb8G99g3j" +
    "4l+xfPB+eQAAAAlwSFlzAAAD6AAAA+gBtXtSawAAALRlWElmSUkqAAgAAAAGABIBAwAB" +
    "AAAAAQAAABoBBQABAAAAVgAAABsBBQABAAAAXgAAACgBAwABAAAAAgAAABMCAwABAAAA" +
    "AQAAAGmHBAABAAAAZgAAAAAAAAA4YwAA6AMAADhjAADoAwAABgAAkAcABAAAADAyMTAB" +
    "kQcABAAAAAECAwAAoAcABAAAADAxMDABoAMAAQAAAP//AAACoAQAAQAAAHgAAAADoAQA" +
    "AQAAAFoAAAAAAAAAFnMTcAAAATtJREFUeJzt1AGNAwEQw8CCOLAFZoAl0X5Wr5GCwHL8" +
    "et7Z83sIL5SfP1EN6IDuP72N0QHdXENGNwcnHd2cRgd0cw0Z3RycdHRzGh3QzTVkdHNw" +
    "0tHNaXRAN9eQ0c3BSUc3p9EB3VxDRjcHJx3dnEYHdHMNGd0cnHR0cxod0M01ZHRzcNLR" +
    "zWl0QDfXkNHNwUlHN6fRAd1cQ0Y3Bycd3ZxGB3RzDRndHJx0dHMaHdDNNWR0c3DS0c1p" +
    "dEA315DRzcFJRzen0QHdXENGNwcnHd2cRgd0cw0Z3RycdHRzGh3QzTVkdHNw0tHNaXRA" +
    "N9eQ0c3BSUc3p9EB3VxDRjcHJx3dnEYHdHMNGd0cnHR0cxod0M01ZHRzcNLRzWl0QDfX" +
    "kNHNwUlHN6fRAd1cQ0Y3Bycd3ZxGB3RzDb9o9AcqYr8NGGNUjgAAAABJRU5ErkJggg==",
  "base64"
);

const PNG_EXIF_ORIENT_3_120x90 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAHgAAABaCAIAAAD8YgW4AAABP2lDQ1BpY2MAAHicfZC/" +
    "SwJxGMY/11WWWA05NBQcJU0FUUtTgYZOEfgj1Kbz/FGgdt33QprLoaloiEZrCaLZxhz6" +
    "A4KgIQqirdWghpKLrw5aUM/yfnh4Xt6XB5TnvFEQ3RoUirYVDvm1eCKpuV5Q8dLPIGO6" +
    "IczlSDAKIPSSMGwrzw+936PIeTe9rhfTO6/Xq8kFpbo7UY4FP1Yu+F/udEYYwBfgM0zL" +
    "BkUDxku2KXkJ8BrrehqUODBlxRNJUPakn2vxieRUiy8lW9FwAJQaoOU6ONXBhfy2vCsl" +
    "v/dkirEI0AeMIggTwv9HpreZCRBgBmRfv3sQ2bnZ1pZnEXqeHOdtElyH0DhynM9Tx2mc" +
    "gfoIta32/mYF5uugHrS91DFc7cPIQ9vzVWCoDNUbU7f0pqUCXdkNqJ/DQAKGb8G99g3j" +
    "4l+xfPB+eQAAAAlwSFlzAAAD6AAAA+gBtXtSawAAALRlWElmSUkqAAgAAAAGABIBAwAB" +
    "AAAAAwAAABoBBQABAAAAVgAAABsBBQABAAAAXgAAACgBAwABAAAAAgAAABMCAwABAAAA" +
    "AQAAAGmHBAABAAAAZgAAAAAAAAA4YwAA6AMAADhjAADoAwAABgAAkAcABAAAADAyMTAB" +
    "kQcABAAAAAECAwAAoAcABAAAADAxMDABoAMAAQAAAP//AAACoAQAAQAAAHgAAAADoAQA" +
    "AQAAAFoAAAAAAAAAE+nmCQAAATtJREFUeJzt1AGNAwEQw8CCOLAFZoAl0X5Wr5GCwHL8" +
    "et7Z83sIL5SfP1EN6IDuP72N0QHdXENGNwcnHd2cRgd0cw0Z3RycdHRzGh3QzTVkdHNw" +
    "0tHNaXRAN9eQ0c3BSUc3p9EB3VxDRjcHJx3dnEYHdHMNGd0cnHR0cxod0M01ZHRzcNLR" +
    "zWl0QDfXkNHNwUlHN6fRAd1cQ0Y3Bycd3ZxGB3RzDRndHJx0dHMaHdDNNWR0c3DS0c1p" +
    "dEA315DRzcFJRzen0QHdXENGNwcnHd2cRgd0cw0Z3RycdHRzGh3QzTVkdHNw0tHNaXRA" +
    "N9eQ0c3BSUc3p9EB3VxDRjcHJx3dnEYHdHMNGd0cnHR0cxod0M01ZHRzcNLRzWl0QDfX" +
    "kNHNwUlHN6fRAd1cQ0Y3Bycd3ZxGB3RzDb9o9AcqYr8NGGNUjgAAAABJRU5ErkJggg==",
  "base64"
);

const PNG_EXIF_ORIENT_6_120x90 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAHgAAABaCAIAAAD8YgW4AAABP2lDQ1BpY2MAAHicfZC/" +
    "SwJxGMY/11WWWA05NBQcJU0FUUtTgYZOEfgj1Kbz/FGgdt33QprLoaloiEZrCaLZxhz6" +
    "A4KgIQqirdWghpKLrw5aUM/yfnh4Xt6XB5TnvFEQ3RoUirYVDvm1eCKpuV5Q8dLPIGO6" +
    "IczlSDAKIPSSMGwrzw+936PIeTe9rhfTO6/Xq8kFpbo7UY4FP1Yu+F/udEYYwBfgM0zL" +
    "BkUDxku2KXkJ8BrrehqUODBlxRNJUPakn2vxieRUiy8lW9FwAJQaoOU6ONXBhfy2vCsl" +
    "v/dkirEI0AeMIggTwv9HpreZCRBgBmRfv3sQ2bnZ1pZnEXqeHOdtElyH0DhynM9Tx2mc" +
    "gfoIta32/mYF5uugHrS91DFc7cPIQ9vzVWCoDNUbU7f0pqUCXdkNqJ/DQAKGb8G99g3j" +
    "4l+xfPB+eQAAAAlwSFlzAAAD6AAAA+gBtXtSawAAALRlWElmSUkqAAgAAAAGABIBAwAB" +
    "AAAABgAAABoBBQABAAAAVgAAABsBBQABAAAAXgAAACgBAwABAAAAAgAAABMCAwABAAAA" +
    "AQAAAGmHBAABAAAAZgAAAAAAAAA4YwAA6AMAADhjAADoAwAABgAAkAcABAAAADAyMTAB" +
    "kQcABAAAAAECAwAAoAcABAAAADAxMDABoAMAAQAAAP//AAACoAQAAQAAAHgAAAADoAQA" +
    "AQAAAFoAAAAAAAAA96n1ZwAAATtJREFUeJzt1AGNAwEQw8CCOLAFZoAl0X5Wr5GCwHL8" +
    "et7Z83sIL5SfP1EN6IDuP72N0QHdXENGNwcnHd2cRgd0cw0Z3RycdHRzGh3QzTVkdHNw" +
    "0tHNaXRAN9eQ0c3BSUc3p9EB3VxDRjcHJx3dnEYHdHMNGd0cnHR0cxod0M01ZHRzcNLR" +
    "zWl0QDfXkNHNwUlHN6fRAd1cQ0Y3Bycd3ZxGB3RzDRndHJx0dHMaHdDNNWR0c3DS0c1p" +
    "dEA315DRzcFJRzen0QHdXENGNwcnHd2cRgd0cw0Z3RycdHRzGh3QzTVkdHNw0tHNaXRA" +
    "N9eQ0c3BSUc3p9EB3VxDRjcHJx3dnEYHdHMNGd0cnHR0cxod0M01ZHRzcNLRzWl0QDfX" +
    "kNHNwUlHN6fRAd1cQ0Y3Bycd3ZxGB3RzDb9o9AcqYr8NGGNUjgAAAABJRU5ErkJggg==",
  "base64"
);

const PNG_EXIF_ORIENT_8_120x90 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAHgAAABaCAIAAAD8YgW4AAABP2lDQ1BpY2MAAHicfZC/" +
    "SwJxGMY/11WWWA05NBQcJU0FUUtTgYZOEfgj1Kbz/FGgdt33QprLoaloiEZrCaLZxhz6" +
    "A4KgIQqirdWghpKLrw5aUM/yfnh4Xt6XB5TnvFEQ3RoUirYVDvm1eCKpuV5Q8dLPIGO6" +
    "IczlSDAKIPSSMGwrzw+936PIeTe9rhfTO6/Xq8kFpbo7UY4FP1Yu+F/udEYYwBfgM0zL" +
    "BkUDxku2KXkJ8BrrehqUODBlxRNJUPakn2vxieRUiy8lW9FwAJQaoOU6ONXBhfy2vCsl" +
    "v/dkirEI0AeMIggTwv9HpreZCRBgBmRfv3sQ2bnZ1pZnEXqeHOdtElyH0DhynM9Tx2mc" +
    "gfoIta32/mYF5uugHrS91DFc7cPIQ9vzVWCoDNUbU7f0pqUCXdkNqJ/DQAKGb8G99g3j" +
    "4l+xfPB+eQAAAAlwSFlzAAAD6AAAA+gBtXtSawAAALRlWElmSUkqAAgAAAAGABIBAwAB" +
    "AAAACAAAABoBBQABAAAAVgAAABsBBQABAAAAXgAAACgBAwABAAAAAgAAABMCAwABAAAA" +
    "AQAAAGmHBAABAAAAZgAAAAAAAAA4YwAA6AMAADhjAADoAwAABgAAkAcABAAAADAyMTAB" +
    "kQcABAAAAAECAwAAoAcABAAAADAxMDABoAMAAQAAAP//AAACoAQAAQAAAHgAAAADoAQA" +
    "AQAAAFoAAAAAAAAA720/CAAAATtJREFUeJzt1AGNAwEQw8CCOLAFZoAl0X5Wr5GCwHL8" +
    "et7Z83sIL5SfP1EN6IDuP72N0QHdXENGNwcnHd2cRgd0cw0Z3RycdHRzGh3QzTVkdHNw" +
    "0tHNaXRAN9eQ0c3BSUc3p9EB3VxDRjcHJx3dnEYHdHMNGd0cnHR0cxod0M01ZHRzcNLR" +
    "zWl0QDfXkNHNwUlHN6fRAd1cQ0Y3Bycd3ZxGB3RzDRndHJx0dHMaHdDNNWR0c3DS0c1p" +
    "dEA315DRzcFJRzen0QHdXENGNwcnHd2cRgd0cw0Z3RycdHRzGh3QzTVkdHNw0tHNaXRA" +
    "N9eQ0c3BSUc3p9EB3VxDRjcHJx3dnEYHdHMNGd0cnHR0cxod0M01ZHRzcNLRzWl0QDfX" +
    "kNHNwUlHN6fRAd1cQ0Y3Bycd3ZxGB3RzDb9o9AcqYr8NGGNUjgAAAABJRU5ErkJggg==",
  "base64"
);

const JPEG_EXIF_THEN_XMP_120x90 = Buffer.from(
  "/9j/4QC8RXhpZgAASUkqAAgAAAAGABIBAwABAAAABgAAABoBBQABAAAAVgAAABsBBQAB" +
    "AAAAXgAAACgBAwABAAAAAgAAABMCAwABAAAAAQAAAGmHBAABAAAAZgAAAAAAAAA4YwAA" +
    "6AMAADhjAADoAwAABgAAkAcABAAAADAyMTABkQcABAAAAAECAwAAoAcABAAAADAxMDAB" +
    "oAMAAQAAAP//AAACoAQAAQAAAHgAAAADoAQAAQAAAFoAAAAAAAAA/+EAT2h0dHA6Ly9u" +
    "cy5hZG9iZS5jb20veGFwLzEuMC8APHg6eG1wbWV0YSB4bWxuczp4PSdhZG9iZTpuczpt" +
    "ZXRhLyc+PC94OnhtcG1ldGE+/+IB8ElDQ19QUk9GSUxFAAEBAAAB4GxjbXMEIAAAbW50" +
    "clJHQiBYWVogB+IAAwAUAAkADgAdYWNzcE1TRlQAAAAAc2F3c2N0cmwAAAAAAAAAAAAA" +
    "AAAAAPbWAAEAAAAA0y1oYW5keem/Vlo+AbaDI4VVRvdPqgAAAAAAAAAAAAAAAAAAAAAA" +
    "AAAAAAAAAAAAAAAAAAAKZGVzYwAAAPwAAAAkY3BydAAAASAAAAAid3RwdAAAAUQAAAAU" +
    "Y2hhZAAAAVgAAAAsclhZWgAAAYQAAAAUZ1hZWgAAAZgAAAAUYlhZWgAAAawAAAAUclRS" +
    "QwAAAcAAAAAgZ1RSQwAAAcAAAAAgYlRSQwAAAcAAAAAgbWx1YwAAAAAAAAABAAAADGVu" +
    "VVMAAAAIAAAAHABzAFIARwBCbWx1YwAAAAAAAAABAAAADGVuVVMAAAAGAAAAHABDAEMA" +
    "MAAAWFlaIAAAAAAAAPbWAAEAAAAA0y1zZjMyAAAAAAABDD8AAAXd///zJgAAB5AAAP2S" +
    "///7of///aIAAAPcAADAcVhZWiAAAAAAAABvoAAAOPIAAAOPWFlaIAAAAAAAAGKWAAC3" +
    "iQAAGNpYWVogAAAAAAAAJKAAAA+FAAC2xHBhcmEAAAAAAAMAAAACZmkAAPKnAAANWQAA" +
    "E9AAAApb/9sAQwAGBAUGBQQGBgUGBwcGCAoQCgoJCQoUDg8MEBcUGBgXFBYWGh0lHxob" +
    "IxwWFiAsICMmJykqKRkfLTAtKDAlKCko/9sAQwEHBwcKCAoTCgoTKBoWGigoKCgoKCgo" +
    "KCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo/8AAEQgAWgB4" +
    "AwEiAAIRAQMRAf/EABUAAQEAAAAAAAAAAAAAAAAAAAAG/8QAFBABAAAAAAAAAAAAAAAA" +
    "AAAAAP/EABYBAQEBAAAAAAAAAAAAAAAAAAAFB//EABQRAQAAAAAAAAAAAAAAAAAAAAD/" +
    "2gAMAwEAAhEDEQA/AJwBEagAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//Z",
  "base64"
);

const JPEG_APP1_AFTER_SOF_120x90 = Buffer.from(
  "/9j/4gHwSUNDX1BST0ZJTEUAAQEAAAHgbGNtcwQgAABtbnRyUkdCIFhZWiAH4gADABQA" +
    "CQAOAB1hY3NwTVNGVAAAAABzYXdzY3RybAAAAAAAAAAAAAAAAAAA9tYAAQAAAADTLWhh" +
    "bmR56b9WWj4BtoMjhVVG90+qAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApk" +
    "ZXNjAAAA/AAAACRjcHJ0AAABIAAAACJ3dHB0AAABRAAAABRjaGFkAAABWAAAACxyWFla" +
    "AAABhAAAABRnWFlaAAABmAAAABRiWFlaAAABrAAAABRyVFJDAAABwAAAACBnVFJDAAAB" +
    "wAAAACBiVFJDAAABwAAAACBtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBH" +
    "AEJtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAYAAAAcAEMAQwAwAABYWVogAAAAAAAA9tYA" +
    "AQAAAADTLXNmMzIAAAAAAAEMPwAABd3///MmAAAHkAAA/ZL///uh///9ogAAA9wAAMBx" +
    "WFlaIAAAAAAAAG+gAAA48gAAA49YWVogAAAAAAAAYpYAALeJAAAY2lhZWiAAAAAAAAAk" +
    "oAAAD4UAALbEcGFyYQAAAAAAAwAAAAJmaQAA8qcAAA1ZAAAT0AAAClv/2wBDAAYEBQYF" +
    "BAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8t" +
    "MC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo" +
    "KCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCABaAHgDASIAAhEBAxEB/+EAvEV4" +
    "aWYAAElJKgAIAAAABgASAQMAAQAAAAYAAAAaAQUAAQAAAFYAAAAbAQUAAQAAAF4AAAAo" +
    "AQMAAQAAAAIAAAATAgMAAQAAAAEAAABphwQAAQAAAGYAAAAAAAAAOGMAAOgDAAA4YwAA" +
    "6AMAAAYAAJAHAAQAAAAwMjEwAZEHAAQAAAABAgMAAKAHAAQAAAAwMTAwAaADAAEAAAD/" +
    "/wAAAqAEAAEAAAB4AAAAA6AEAAEAAABaAAAAAAAAAP/EABUAAQEAAAAAAAAAAAAAAAAA" +
    "AAAG/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/EABYBAQEBAAAAAAAAAAAAAAAAAAAFB//E" +
    "ABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJwBEagAAAAAAAAAAAAAAAAA" +
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
    "AAAAAAAAA//Z",
  "base64"
);

describe("imageDimensionsFromBuffer", () => {
  it.each([
    ["PNG", PNG_37x19, 37, 19],
    ["baseline JPEG", JPEG_64x41, 64, 41],
    ["JPEG behind an EXIF block", JPEG_EXIF_120x90, 120, 90],
    ["GIF89a", GIF_23x71, 23, 71],
    ["lossy WebP (VP8 )", WEBP_LOSSY_52x29, 52, 29],
    ["lossless WebP (VP8L)", WEBP_LOSSLESS_17x83, 17, 83],
    ["extended WebP (VP8X)", WEBP_VP8X_96x31, 96, 31],
  ])("reads %s", (_label, buffer, width, height) => {
    expect(imageDimensionsFromBuffer(buffer)).toEqual({ width, height });
  });

  it("returns null for a truncated header rather than throwing", () => {
    // Each format cut one byte short of the last byte its header needs, plus
    // the degenerate prefixes a partially-written upload leaves behind.
    const cases: Array<[Buffer, number]> = [
      [PNG_37x19, 23],
      [JPEG_64x41, 10],
      [GIF_23x71, 9],
      [WEBP_LOSSY_52x29, 29],
      [WEBP_LOSSLESS_17x83, 24],
      [WEBP_VP8X_96x31, 29],
    ];
    for (const [buffer, shortOf] of cases) {
      for (const keep of [0, 1, 2, 4, shortOf]) {
        expect(imageDimensionsFromBuffer(buffer.subarray(0, keep))).toBeNull();
      }
    }
  });

  it("returns null for a file that claims to be an image and is not", () => {
    // Right magic bytes, garbage after them — the shape a corrupted or
    // partially-written upload takes.
    const corruptPng = Buffer.concat([
      PNG_37x19.subarray(0, 8),
      Buffer.alloc(64, 0xab),
    ]);
    expect(imageDimensionsFromBuffer(corruptPng)).toBeNull();

    const corruptRiff = Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.alloc(64, 0x00),
    ]);
    expect(imageDimensionsFromBuffer(corruptRiff)).toBeNull();
  });

  it("returns null for bytes of no image format at all", () => {
    expect(imageDimensionsFromBuffer(Buffer.alloc(0))).toBeNull();
    expect(imageDimensionsFromBuffer(Buffer.from("not an image"))).toBeNull();
    expect(
      imageDimensionsFromBuffer(Buffer.from("%PDF-1.7\n%abcd"))
    ).toBeNull();
  });

  it("rejects a header whose dimensions are impossible", () => {
    // A PNG IHDR claiming zero width: structurally valid, semantically not.
    const zeroWidth = Buffer.from(PNG_37x19);
    zeroWidth.writeUInt32BE(0, 16);
    expect(imageDimensionsFromBuffer(zeroWidth)).toBeNull();

    const absurd = Buffer.from(PNG_37x19);
    absurd.writeUInt32BE(4_000_000_000, 16);
    expect(imageDimensionsFromBuffer(absurd)).toBeNull();
  });
});

describe("probeImageFile", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "dispatch-image-dims-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(name: string, buffer: Buffer): Promise<string> {
    const filePath = path.join(dir, name);
    await writeFile(filePath, buffer);
    return filePath;
  }

  it("reads dimensions off disk", async () => {
    await expect(
      probeImageFile(await write("a.png", PNG_37x19))
    ).resolves.toEqual({ width: 37, height: 19 });
    await expect(
      probeImageFile(await write("b.jpg", JPEG_EXIF_120x90))
    ).resolves.toEqual({ width: 120, height: 90 });
    await expect(
      probeImageFile(await write("c.webp", WEBP_LOSSLESS_17x83))
    ).resolves.toEqual({ width: 17, height: 83 });
  });

  it("skips files that are not images without reading them", async () => {
    await expect(
      probeImageFile(await write("notes.md", Buffer.from("# hi")))
    ).resolves.toBeNull();
    await expect(
      probeImageFile(await write("clip.mp4", Buffer.alloc(32)))
    ).resolves.toBeNull();
  });

  it("returns null for a malformed image rather than throwing", async () => {
    await expect(
      probeImageFile(await write("broken.png", Buffer.from("nope")))
    ).resolves.toBeNull();
  });

  it("refuses a file whose orientation sits beyond the head read", async () => {
    // A metadata chunk large enough to push eXIf past the bounded read. The
    // orientation is real and rotates the image, so answering from the IHDR
    // alone would confidently return the ratio the wrong way round — worse
    // than the fixed-height fallback that null selects.
    const eXIf = PNG_EXIF_ORIENT_6_120x90.indexOf(Buffer.from("eXIf"));
    const body = Buffer.concat([
      Buffer.from("Comment\0", "latin1"),
      Buffer.alloc(1200 * 1024, 0x41),
    ]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const filler = Buffer.concat([
      length,
      Buffer.from("tEXt", "latin1"),
      body,
      Buffer.alloc(4),
    ]);
    const padded = Buffer.concat([
      PNG_EXIF_ORIENT_6_120x90.subarray(0, eXIf - 4),
      filler,
      PNG_EXIF_ORIENT_6_120x90.subarray(eXIf - 4),
    ]);

    // Whole file in memory: the rotation is found and applied.
    expect(imageDimensionsFromBuffer(padded)).toEqual({
      width: 90,
      height: 120,
    });
    // Off disk, where only the head is read: no answer rather than a wrong one.
    await expect(
      probeImageFile(await write("padded.png", padded))
    ).resolves.toBeNull();
  });

  it("returns null when the file is gone", async () => {
    await expect(
      probeImageFile(path.join(dir, "missing.png"))
    ).resolves.toBeNull();
  });
});

describe("JPEG EXIF orientation", () => {
  // Verified against Chromium: served through the real media endpoint, these
  // four files report naturalWidth/naturalHeight of 120x90, 120x90, 90x120
  // and 90x120 respectively. The stored pair has to match what the browser
  // lays out, not what the SOF frame says.
  it.each([
    ["1 (no transform)", JPEG_ORIENT_1_120x90, 120, 90],
    ["3 (180 degrees, no swap)", JPEG_ORIENT_3_120x90, 120, 90],
    ["6 (quarter turn)", JPEG_ORIENT_6_120x90, 90, 120],
    ["8 (quarter turn back)", JPEG_ORIENT_8_120x90, 90, 120],
  ])("reports orientation %s as the browser lays it out", (_l, buf, w, h) => {
    expect(imageDimensionsFromBuffer(buf)).toEqual({ width: w, height: h });
  });
});

describe("JPEG segment-chain strictness", () => {
  // A SOF-shaped run of bytes is only a frame header if the chain actually
  // leads there. Reporting confident dimensions for these would reserve a box
  // the real image cannot fit — worse than reserving nothing.
  const sofPayload = [
    0x08, 0x00, 0x13, 0x00, 0x25, 0x03, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0,
  ];

  it("refuses a broken chain that happens to contain a SOF", () => {
    const junk = Buffer.from([
      0xff, 0xd8, 0x67, 0x61, 0x72, 0x62, 0x61, 0x67, 0x65, 0xff, 0xc0, 0x00,
      0x02, 0x08, 0x00, 0x13, 0x00, 0x25,
    ]);
    expect(imageDimensionsFromBuffer(junk)).toBeNull();
  });

  it("refuses a SOF that appears after end-of-image", () => {
    const afterEoi = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, ...sofPayload]),
    ]);
    expect(imageDimensionsFromBuffer(afterEoi)).toBeNull();
  });

  it("refuses a frame that ends without a scan", () => {
    // A size with no image data behind it is not a size.
    const noScan = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, ...sofPayload]),
      Buffer.from([0xff, 0xd9]),
    ]);
    expect(imageDimensionsFromBuffer(noScan)).toBeNull();
  });

  it.each([
    ["a padding byte", [0xff, 0x00, 0x00, 0x02]],
    ["a nested start-of-image", [0xff, 0xd8, 0x00, 0x02]],
    ["a restart marker outside a scan", [0xff, 0xd0]],
  ])("refuses %s at a segment boundary", (_label, prefix) => {
    const bad = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from(prefix),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, ...sofPayload]),
      Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    ]);
    expect(imageDimensionsFromBuffer(bad)).toBeNull();
  });

  it("refuses a scan header whose length is impossible", () => {
    const badSos = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, ...sofPayload]),
      Buffer.from([0xff, 0xda, 0x00, 0x00, 0, 0, 0, 0]),
    ]);
    expect(imageDimensionsFromBuffer(badSos)).toBeNull();
  });

  it("refuses a SOF whose length does not match its component count", () => {
    // Declares three components but a length that only fits one.
    const badLength = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xc0, 0x00, 0x0b, ...sofPayload]),
    ]);
    expect(imageDimensionsFromBuffer(badLength)).toBeNull();
  });

  it("refuses a SOF with an impossible sample precision", () => {
    const badPrecision = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([
        0xff, 0xc0, 0x00, 0x11, 0x07, 0x00, 0x13, 0x00, 0x25, 0x03, 1, 0x11, 0,
        2, 0x11, 0, 3, 0x11, 0,
      ]),
    ]);
    expect(imageDimensionsFromBuffer(badPrecision)).toBeNull();
  });

  // A scan header, enough of one to end the metadata walk.
  const sos = Buffer.from([
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
  ]);

  it("accepts a well-formed minimal frame", () => {
    const ok = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, ...sofPayload]),
      sos,
    ]);
    expect(imageDimensionsFromBuffer(ok)).toEqual({ width: 37, height: 19 });
  });

  it("refuses a frame whose metadata never finished", () => {
    // No scan and no end marker: an orientation could still be ahead of us,
    // so the size on its own is not an answer.
    const unfinished = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, ...sofPayload]),
    ]);
    expect(imageDimensionsFromBuffer(unfinished)).toBeNull();
  });
});

describe("orientation beyond a single JPEG EXIF block", () => {
  it.each([
    ["1", PNG_EXIF_ORIENT_1_120x90, 120, 90],
    ["3", PNG_EXIF_ORIENT_3_120x90, 120, 90],
    ["6", PNG_EXIF_ORIENT_6_120x90, 90, 120],
    ["8", PNG_EXIF_ORIENT_8_120x90, 90, 120],
  ])("applies a PNG eXIf orientation of %s", (_l, buf, w, h) => {
    expect(imageDimensionsFromBuffer(buf)).toEqual({ width: w, height: h });
  });

  it("keeps an orientation that a later non-EXIF APP1 does not carry", () => {
    // An XMP APP1 after the EXIF one must not read as "orientation 1".
    expect(imageDimensionsFromBuffer(JPEG_EXIF_THEN_XMP_120x90)).toEqual({
      width: 90,
      height: 120,
    });
  });

  it("applies an EXIF APP1 that sits after the frame header", () => {
    // Reading the frame and returning there would get the size right and the
    // rotation wrong; metadata is only settled once the scan starts.
    expect(imageDimensionsFromBuffer(JPEG_APP1_AFTER_SOF_120x90)).toEqual({
      width: 90,
      height: 120,
    });
  });
});

describe("container structure", () => {
  // The bytes holding a dimension are only trustworthy if the chunk that
  // claims to own them says it is long enough to. Browsers reject each of
  // these outright; a parser that answers anyway is answering about bytes no
  // container vouches for.
  it("refuses a PNG whose IHDR length is not 13", () => {
    const bad = Buffer.from(PNG_37x19);
    bad.writeUInt32BE(0, 8);
    expect(imageDimensionsFromBuffer(bad)).toBeNull();
  });

  it.each([
    ["lossy", WEBP_LOSSY_52x29],
    ["lossless", WEBP_LOSSLESS_17x83],
    ["extended", WEBP_VP8X_96x31],
  ])("refuses a %s WebP whose chunk size is zero", (_l, source) => {
    const bad = Buffer.from(source);
    bad.writeUInt32LE(0, 16);
    expect(imageDimensionsFromBuffer(bad)).toBeNull();
  });

  it("refuses a GIF cut short of its logical screen descriptor", () => {
    expect(imageDimensionsFromBuffer(GIF_23x71.subarray(0, 10))).toBeNull();
    expect(imageDimensionsFromBuffer(GIF_23x71)).toEqual({
      width: 23,
      height: 71,
    });
  });
});
