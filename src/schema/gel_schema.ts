import { gelSchema } from "./declarative.js";

export const GEL_REFERENCE_SCHEMA = gelSchema`
module default {
  abstract type Content {
    required title: str;
    multi tags: str;
  }

  type User {
    required name: str;
    required email: str;
    multi authored -> Content {
      required role: str;
      created_at: datetime;
    };
  }

  type Post extending Content {
    required author -> User;
    body: str;
    multi comments -> Comment;
  }

  type Comment extending Content {
    required author -> User;
    required post -> Post;
    body: str;
  }

  type AuditLog {
    required actor -> User;
    required subject_id: uuid;
    required action: str;
    metadata: json;
  }
}
`;
