// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "ApproveHere",
  platforms: [.macOS(.v13)],
  targets: [
    .executableTarget(name: "ApproveHere", path: "Sources/ApproveHere")
  ]
)
