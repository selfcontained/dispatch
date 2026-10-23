import Foundation
import Darwin

public final class RecoveryWorkerLog {
    public let pipe = Pipe()
    private let file: FileHandle
    private let lock = NSLock()
    private var remaining = 1024 * 1024
    private var closed = false
    public init(url: URL) throws {
        let fd = open(url.path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw ConfigurationError("Cannot open probation worker log.") }
        file = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        guard fchmod(fd, 0o600) == 0 else { throw ConfigurationError("Cannot protect probation worker log.") }
        pipe.fileHandleForReading.readabilityHandler = { [weak self] input in
            guard let self else { return }
            self.lock.lock(); defer { self.lock.unlock() }
            guard !self.closed else { return }
            self.append(input.availableData)
        }
    }
    private func append(_ data: Data) {
        let chunk = data.prefix(remaining)
        try? file.write(contentsOf: chunk); remaining -= chunk.count
    }
    public func close() {
        pipe.fileHandleForReading.readabilityHandler = nil
        lock.lock(); defer { lock.unlock() }
        guard !closed else { return }
        closed = true
        let fd = pipe.fileHandleForReading.fileDescriptor
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
        var buffer = [UInt8](repeating: 0, count: 16384)
        while true {
            let count = Darwin.read(fd, &buffer, buffer.count)
            guard count > 0 else { break }
            append(Data(buffer.prefix(count)))
        }
        try? file.synchronize(); try? file.close()
        try? pipe.fileHandleForReading.close(); try? pipe.fileHandleForWriting.close()
    }
}
