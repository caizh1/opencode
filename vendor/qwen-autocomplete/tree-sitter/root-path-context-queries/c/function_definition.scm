(function_definition
  type: [
    (type_identifier) @return_type
    (struct_specifier name: (type_identifier) @return_type)
    (union_specifier name: (type_identifier) @return_type)
    (enum_specifier name: (type_identifier) @return_type)
  ]
)

(function_definition
  declarator: (function_declarator
    parameters: (parameter_list
      (parameter_declaration
        type: [
          (type_identifier) @parameter_type
          (struct_specifier name: (type_identifier) @parameter_type)
          (union_specifier name: (type_identifier) @parameter_type)
          (enum_specifier name: (type_identifier) @parameter_type)
        ]
      )
    )
  )
)
