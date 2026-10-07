Dispatch Preview includes PostgreSQL 17.10 from EDB's macOS universal binary
archive. SOURCE.json in the runtime records the pinned download and SHA-256.
The PostgreSQL notice is preserved as PostgreSQL.html. The other license texts
cover the dynamically linked OpenSSL, ICU, MIT Kerberos, libedit, LZ4,
Zstandard, libxml2, zlib and GNU libiconv libraries. SOURCES.json records the
upstream locations of the notices. These notices are included unchanged.

GNU libiconv 1.19 is LGPL-licensed and dynamically linked. Its upstream source,
including configure/Makefile build machinery and installation instructions, is
included as libiconv-1.19.tar.gz. Users may modify or replace this library under
the LGPL, including reverse engineering for debugging those modifications.
The original application signature will need to be replaced after modifying
bundled libraries. Dispatch does not restrict that modification.

The runtime includes core PostgreSQL, PL/pgSQL, encoding conversion modules,
and text search. It does not include EDB's optional language pack or pgAdmin.
