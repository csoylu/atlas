// OCR PNG screenshots with Apple Vision (used by scripts/ui-check.mjs).
// Usage: ocr <png>... → one JSON object per line: {"file", "w", "h", "lines": [{"text", "conf", "x", "y", "w", "h"}]}
// Boxes are in image pixels, top-left origin.
import Foundation
import Vision
import AppKit

for path in CommandLine.arguments.dropFirst() {
  guard let img = NSImage(contentsOfFile: path), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("cannot open \(path)\n".data(using: .utf8)!)
    exit(1)
  }
  let W = Double(cg.width), H = Double(cg.height)
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = .accurate
  req.usesLanguageCorrection = false
  try VNImageRequestHandler(cgImage: cg).perform([req])
  var lines: [[String: Any]] = []
  for o in req.results ?? [] {
    guard let c = o.topCandidates(1).first else { continue }
    let b = o.boundingBox
    lines.append(["text": c.string, "conf": Double(c.confidence), "x": b.minX * W, "y": (1 - b.maxY) * H, "w": b.width * W, "h": b.height * H])
  }
  let out: [String: Any] = ["file": path, "w": W, "h": H, "lines": lines]
  let data = try JSONSerialization.data(withJSONObject: out)
  print(String(data: data, encoding: .utf8)!)
}
