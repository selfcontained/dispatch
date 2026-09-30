import ServiceManagement

extension SMAppService.Status {
    /// A fresh bundle can report notFound before BTM has a record for it.
    /// Registration must create that record instead of waiting for it to exist.
    var needsRegistration: Bool { self == .notRegistered || self == .notFound }
}
