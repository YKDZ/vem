#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ADMIN_API_DIRECTORY = "apps/admin-ui/src/api";
const EXCLUDED_API_FILES = new Set([
  "apps/admin-ui/src/api/auth.ts",
  "apps/admin-ui/src/api/request.ts",
]);
const WRITE_HELPERS = new Set(["post", "patch"]);
const CONTRACT_WRITE_HELPERS = new Set([
  "postContract",
  "patchContract",
  "postResponseContract",
  "callAdminEndpointContract",
]);
const RAW_ADMIN_HELPERS = new Set(["get", "post", "put", "patch", "delete"]);
const LEGACY_CONTRACT_HELPERS = new Set([
  "getContract",
  "postContract",
  "putContract",
  "patchContract",
  "postResponseContract",
]);
const REQUEST_HELPERS = new Set([
  ...RAW_ADMIN_HELPERS,
  ...LEGACY_CONTRACT_HELPERS,
  "callAdminEndpointContract",
]);
const MIGRATION_ADMIN_API_PATHS = new Set([
  "apps/admin-ui/src/api/products.ts",
  "apps/admin-ui/src/api/try-on-garments.ts",
]);
const WRITE_CALL_PATTERN =
  /\b(?:post|patch|postContract|patchContract|postResponseContract|callAdminEndpointContract)\s*(?:<[\s\S]*?>)?\s*\(/;
const BROAD_TYPE_PATTERN = /\b(?:Record\s*<\s*string\s*,\s*unknown\s*>|any)\b/;
const SHARED_BODY_TYPE_PATTERN =
  /\b(?:z\.input\s*<|Admin[A-Z][A-Za-z0-9]*(?:Request|Input)|MachineEnvironmentControlRequest)\b/;
const LOCAL_TYPE_UTILITY_NAMES = new Set([
  "Array",
  "Blob",
  "Date",
  "Exclude",
  "Extract",
  "File",
  "FormData",
  "Map",
  "NonNullable",
  "Omit",
  "Partial",
  "Pick",
  "Promise",
  "Readonly",
  "ReadonlyArray",
  "Record",
  "Required",
  "Set",
]);

function pathExists(root, path) {
  try {
    return statSync(join(root, path)).isFile();
  } catch {
    return false;
  }
}

function directoryExists(root, path) {
  try {
    return statSync(join(root, path)).isDirectory();
  } catch {
    return false;
  }
}

function readText(root, path) {
  return readFileSync(join(root, path), "utf8");
}

function listFiles(root, directory) {
  if (!directoryExists(root, directory)) return [];

  const absoluteDirectory = join(root, directory);
  const files = [];
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const absolutePath = join(absoluteDirectory, entry.name);
    const repositoryPath = relative(root, absolutePath).split(sep).join("/");
    if (entry.isDirectory()) {
      files.push(...listFiles(root, repositoryPath));
    } else if (entry.isFile() && repositoryPath.endsWith(".ts")) {
      files.push(repositoryPath);
    }
  }
  return files.sort();
}

function extractFunctions(source) {
  const functions = [];
  const declarationPattern =
    /export\s+async\s+function\s+([A-Za-z0-9_]+)\s*\(/g;
  const asyncArrowPattern =
    /export\s+const\s+([A-Za-z0-9_]+)\s*=\s*async\s*(?:<[\s\S]*?>\s*)?\(/g;

  let match;
  while ((match = declarationPattern.exec(source)) !== null) {
    const [, name] = match;
    const parametersStart = declarationPattern.lastIndex;
    let parameterDepth = 1;
    let parametersEnd = parametersStart;
    for (; parametersEnd < source.length; parametersEnd += 1) {
      const character = source[parametersEnd];
      if (character === "(") parameterDepth += 1;
      if (character === ")") parameterDepth -= 1;
      if (parameterDepth === 0) break;
    }

    const parameters = source.slice(parametersStart, parametersEnd);
    let bodyOpen = -1;
    for (let index = parametersEnd + 1; index < source.length; index += 1) {
      if (source[index] !== "{") continue;
      const nextSource = source.slice(index + 1).trimStart();
      if (/^(return|await|const|let|if|for|try)\b/.test(nextSource)) {
        bodyOpen = index;
        break;
      }
    }
    if (bodyOpen === -1) continue;

    const bodyStart = bodyOpen + 1;
    let depth = 1;
    let index = bodyStart;
    for (; index < source.length; index += 1) {
      const character = source[index];
      if (character === "{") depth += 1;
      if (character === "}") depth -= 1;
      if (depth === 0) break;
    }
    functions.push({
      name,
      parameters,
      body: source.slice(bodyStart, index),
    });
    declarationPattern.lastIndex = index + 1;
  }

  while ((match = asyncArrowPattern.exec(source)) !== null) {
    const [, name] = match;
    const parametersStart = asyncArrowPattern.lastIndex;
    const parametersEnd = findBalancedEnd(
      source,
      parametersStart - 1,
      "(",
      ")",
    );
    if (parametersEnd === -1) continue;

    const arrowStart = source.indexOf("=>", parametersEnd + 1);
    if (arrowStart === -1) continue;

    const bodyStart = skipWhitespace(source, arrowStart + 2);
    if (source[bodyStart] === "{") {
      const bodyEnd = findBalancedEnd(source, bodyStart, "{", "}");
      if (bodyEnd === -1) continue;
      functions.push({
        name,
        parameters: source.slice(parametersStart, parametersEnd),
        body: source.slice(bodyStart + 1, bodyEnd),
      });
      asyncArrowPattern.lastIndex = bodyEnd + 1;
      continue;
    }

    const bodyEnd = findExpressionEnd(source, bodyStart);
    functions.push({
      name,
      parameters: source.slice(parametersStart, parametersEnd),
      body: source.slice(bodyStart, bodyEnd),
    });
    asyncArrowPattern.lastIndex = bodyEnd;
  }

  return functions;
}

function skipWhitespace(source, start) {
  let index = start;
  while (/\s/.test(source[index] ?? "")) index += 1;
  return index;
}

function findBalancedEnd(source, openIndex, openCharacter, closeCharacter) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    if (character === openCharacter) depth += 1;
    if (character === closeCharacter) depth -= 1;
    if (depth === 0) return index;
  }
  return -1;
}

function findExpressionEnd(source, start) {
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(") parenDepth += 1;
    if (character === ")") parenDepth -= 1;
    if (character === "{") braceDepth += 1;
    if (character === "}") braceDepth -= 1;
    if (character === "[") bracketDepth += 1;
    if (character === "]") bracketDepth -= 1;
    if (
      character === ";" &&
      parenDepth === 0 &&
      braceDepth === 0 &&
      bracketDepth === 0
    ) {
      return index;
    }
  }
  return source.length;
}

function helperCalls(functionSource) {
  const calls = [];
  const callPattern =
    /\b(post|patch|postContract|patchContract|postResponseContract|callAdminEndpointContract)\s*(?:<[\s\S]*?>)?\s*\(/g;
  let match;
  while ((match = callPattern.exec(functionSource)) !== null) {
    calls.push(match[1]);
  }
  return calls;
}

const TRY_ON_CONTRACT_NAMES = [
  "adminProductDisplayImageUploadContract",
  "adminListProductsContract",
  "adminCreateProductContract",
  "adminUpdateProductContract",
  "adminListProductVariantsContract",
  "adminCreateProductVariantContract",
  "adminUpdateProductVariantContract",
  "adminTryOnGarmentUploadContract",
  "adminCreateTryOnGarmentContract",
  "adminGetTryOnGarmentContract",
  "adminListTryOnGarmentsByProductContract",
  "adminTryOnGarmentConfirmationContract",
  "adminTryOnGarmentActivationContract",
  "adminTryOnGarmentRetirementContract",
  "adminTryOnGarmentAssociationContract",
  "adminTryOnGarmentSourceReplacementContract",
];
const PRODUCT_CATALOG_CONTRACT_NAMES = new Set(
  TRY_ON_CONTRACT_NAMES.slice(0, 7),
);

const TRY_ON_CONTRACT_EXPECTATIONS = {
  adminProductDisplayImageUploadContract: {
    method: "POST",
    path: "/media-assets/product-display-images",
    providerMethod: "uploadProductDisplayImage",
    callerMethods: ["uploadProductDisplayImage"],
    schemaReferences: { responseSchema: ["adminMediaAssetSummarySchema"] },
  },
  adminListProductsContract: {
    method: "GET",
    path: "/products",
    providerMethod: "listProducts",
    callerMethods: ["listProducts"],
    schemaReferences: {
      pathParamsSchema: ["noProductPathParamsSchema"],
      querySchema: ["adminProductListQuerySchema"],
      bodySchema: ["noProductBodySchema"],
      responseSchema: ["adminProductPageResponseSchema"],
    },
  },
  adminCreateProductContract: {
    method: "POST",
    path: "/products",
    providerMethod: "createProduct",
    callerMethods: ["createProduct"],
    schemaReferences: {
      pathParamsSchema: ["noProductPathParamsSchema"],
      querySchema: ["noProductQuerySchema"],
      bodySchema: ["createProductSchema"],
      responseSchema: ["adminProductResponseSchema"],
    },
  },
  adminUpdateProductContract: {
    method: "PATCH",
    path: "/products/:id",
    providerMethod: "updateProduct",
    callerMethods: ["updateProduct"],
    schemaReferences: {
      pathParamsSchema: ["productIdPathParamsSchema"],
      querySchema: ["noProductQuerySchema"],
      bodySchema: ["updateProductSchema"],
      responseSchema: ["adminProductResponseSchema"],
    },
  },
  adminListProductVariantsContract: {
    method: "GET",
    path: "/product-variants",
    providerMethod: "listVariants",
    callerMethods: ["listProductVariants"],
    schemaReferences: {
      pathParamsSchema: ["noProductPathParamsSchema"],
      querySchema: ["adminProductVariantListQuerySchema"],
      bodySchema: ["noProductBodySchema"],
      responseSchema: ["adminProductVariantPageResponseSchema"],
    },
  },
  adminCreateProductVariantContract: {
    method: "POST",
    path: "/product-variants",
    providerMethod: "createVariant",
    callerMethods: ["createProductVariant"],
    schemaReferences: {
      pathParamsSchema: ["noProductPathParamsSchema"],
      querySchema: ["noProductQuerySchema"],
      bodySchema: ["createProductVariantSchema"],
      responseSchema: ["adminProductVariantResponseSchema"],
    },
  },
  adminUpdateProductVariantContract: {
    method: "PATCH",
    path: "/product-variants/:id",
    providerMethod: "updateVariant",
    callerMethods: ["updateProductVariant"],
    schemaReferences: {
      pathParamsSchema: ["productIdPathParamsSchema"],
      querySchema: ["noProductQuerySchema"],
      bodySchema: ["updateProductVariantSchema"],
      responseSchema: ["adminProductVariantResponseSchema"],
    },
  },
  adminTryOnGarmentUploadContract: {
    method: "POST",
    path: "/media-assets/try-on-garments",
    providerMethod: "uploadTryOnGarment",
    callerMethods: ["uploadTryOnGarment"],
    schemaReferences: {
      querySchema: ["noQuerySchema"],
      responseSchema: ["tryOnGarmentMediaAssetSchema"],
    },
  },
  adminCreateTryOnGarmentContract: {
    method: "POST",
    path: "/try-on-garments",
    providerMethod: "createDraft",
    callerMethods: ["createTryOnGarmentDraft"],
    schemaReferences: {
      querySchema: ["noQuerySchema"],
      bodySchema: ["tryOnGarmentDraftRequestSchema"],
      responseSchema: ["tryOnGarmentResponseSchema"],
    },
  },
  adminGetTryOnGarmentContract: {
    method: "GET",
    path: "/try-on-garments/:id",
    providerMethod: "getById",
    callerMethods: ["getTryOnGarment"],
    schemaReferences: {
      pathParamsSchema: ["garmentPathParamsSchema"],
      querySchema: ["noQuerySchema"],
      bodySchema: ["noBodySchema"],
      responseSchema: ["tryOnGarmentResponseSchema"],
    },
  },
  adminListTryOnGarmentsByProductContract: {
    method: "GET",
    path: "/try-on-garments",
    providerMethod: "listByProduct",
    callerMethods: ["listTryOnGarmentsByProduct"],
    schemaReferences: {
      querySchema: ["garmentListQuerySchema"],
      bodySchema: ["noBodySchema"],
      responseSchema: ["tryOnGarmentListResponseSchema"],
    },
  },
  adminTryOnGarmentConfirmationContract: {
    method: "POST",
    path: "/try-on-garments/:id/confirmation",
    providerMethod: "confirm",
    callerMethods: ["confirmTryOnGarment"],
    schemaReferences: {
      pathParamsSchema: ["garmentPathParamsSchema"],
      querySchema: ["noQuerySchema"],
      bodySchema: ["noBodySchema"],
      responseSchema: ["tryOnGarmentResponseSchema"],
    },
  },
  adminTryOnGarmentActivationContract: {
    method: "POST",
    path: "/try-on-garments/:id/activation",
    providerMethod: "activate",
    callerMethods: ["activateTryOnGarment"],
    schemaReferences: {
      pathParamsSchema: ["garmentPathParamsSchema"],
      querySchema: ["noQuerySchema"],
      bodySchema: ["noBodySchema"],
      responseSchema: ["tryOnGarmentResponseSchema"],
    },
  },
  adminTryOnGarmentRetirementContract: {
    method: "POST",
    path: "/try-on-garments/:id/retirement",
    providerMethod: "retire",
    callerMethods: ["retireTryOnGarment"],
    schemaReferences: {
      pathParamsSchema: ["garmentPathParamsSchema"],
      querySchema: ["noQuerySchema"],
      bodySchema: ["noBodySchema"],
      responseSchema: ["tryOnGarmentResponseSchema"],
    },
  },
  adminTryOnGarmentAssociationContract: {
    method: "PUT",
    path: "/try-on-garments/:id/variant-associations",
    providerMethod: "replaceVariantAssociations",
    callerMethods: ["replaceTryOnGarmentVariantAssociations"],
    schemaReferences: {
      pathParamsSchema: ["garmentPathParamsSchema"],
      querySchema: ["noQuerySchema"],
      bodySchema: ["tryOnGarmentVariantAssociationRequestSchema"],
      responseSchema: ["tryOnGarmentResponseSchema"],
    },
  },
  adminTryOnGarmentSourceReplacementContract: {
    method: "PATCH",
    path: "/try-on-garments/:id/source",
    providerMethod: "replaceSource",
    callerMethods: ["replaceTryOnGarmentSource"],
    schemaReferences: {
      pathParamsSchema: ["garmentPathParamsSchema"],
      querySchema: ["noQuerySchema"],
      bodySchema: ["tryOnGarmentSourceReplacementRequestSchema"],
      responseSchema: ["tryOnGarmentResponseSchema"],
    },
  },
};

const TRY_ON_CONTRACT_FIELDS = [
  "method",
  "path",
  "pathParamsSchema",
  "querySchema",
  "bodySchema",
  "responseSchema",
];

function parseTypeScript(path, source) {
  return ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function decoratorsOf(node) {
  return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
}

function decoratorCall(decorator) {
  const expression = decorator.expression;
  if (!ts.isCallExpression(expression)) return undefined;
  const callee = expression.expression;
  if (!ts.isIdentifier(callee)) return undefined;
  return {
    name: callee.text,
    argument:
      expression.arguments.length === 1 &&
      ts.isIdentifier(expression.arguments[0])
        ? expression.arguments[0].text
        : undefined,
  };
}

function contractDefinitions(root) {
  const definitions = new Map();
  for (const path of [
    "packages/shared/src/schemas/products.ts",
    "packages/shared/src/schemas/try-on-garments.ts",
  ]) {
    if (!pathExists(root, path)) continue;
    const source = readText(root, path);
    const file = parseTypeScript(path, source);
    file.forEachChild((statement) => {
      if (!ts.isVariableStatement(statement)) return;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        if (
          !declaration.initializer ||
          !ts.isCallExpression(declaration.initializer) ||
          !ts.isIdentifier(declaration.initializer.expression) ||
          declaration.initializer.expression.text !==
            "defineAdminEndpointContract"
        ) {
          continue;
        }
        const argument = declaration.initializer.arguments[0];
        if (!argument || !ts.isObjectLiteralExpression(argument)) continue;
        const values = {};
        const invalidSchemaFields = new Set();
        for (const property of argument.properties) {
          const propertyName =
            ts.isPropertyAssignment(property) ||
            ts.isShorthandPropertyAssignment(property)
              ? ts.isIdentifier(property.name)
                ? property.name.text
                : ts.isStringLiteral(property.name)
                  ? property.name.text
                  : undefined
              : undefined;
          if (!propertyName) continue;
          values[propertyName] = ts.isShorthandPropertyAssignment(property)
            ? property.name
            : property.initializer;
          if (
            [
              "pathParamsSchema",
              "querySchema",
              "bodySchema",
              "responseSchema",
            ].includes(propertyName) &&
            isUnknownSchemaExpression(values[propertyName])
          ) {
            invalidSchemaFields.add(propertyName);
          }
        }
        definitions.set(declaration.name.text, { values, invalidSchemaFields });
      }
    });
  }
  return definitions;
}

function isUnknownSchemaExpression(expression) {
  if (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === "z" &&
    ["any", "unknown"].includes(expression.expression.name.text)
  ) {
    return true;
  }
  return (
    ts.isIdentifier(expression) && ["any", "unknown"].includes(expression.text)
  );
}

function decoratedMethods(root, directory, decoratorName) {
  const methods = [];
  for (const path of listFiles(root, directory)) {
    if (!path.endsWith(".controller.ts")) continue;
    const source = readText(root, path);
    const file = parseTypeScript(path, source);
    const visit = (node) => {
      if (
        ts.isMethodDeclaration(node) &&
        node.name &&
        ts.isIdentifier(node.name)
      ) {
        for (const decorator of decoratorsOf(node)) {
          const call = decoratorCall(decorator);
          if (call?.name !== decoratorName) continue;
          methods.push({
            path,
            method: node.name.text,
            contract: call.argument,
            controller: enclosingClassName(node),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return methods;
}

function enclosingClassName(node) {
  let current = node.parent;
  while (current) {
    if (ts.isClassDeclaration(current) && current.name) {
      return current.name.text;
    }
    current = current.parent;
  }
  return undefined;
}

function registeredControllers(root) {
  const registered = new Set();
  for (const path of listFiles(root, "apps/service-api/src")) {
    if (!path.endsWith(".module.ts")) continue;
    const file = parseTypeScript(path, readText(root, path));
    const visit = (node) => {
      if (ts.isDecorator(node)) {
        const expression = node.expression;
        if (
          ts.isCallExpression(expression) &&
          ts.isIdentifier(expression.expression) &&
          expression.expression.text === "Module" &&
          expression.arguments.length === 1 &&
          ts.isObjectLiteralExpression(expression.arguments[0])
        ) {
          for (const property of expression.arguments[0].properties) {
            if (
              !ts.isPropertyAssignment(property) ||
              !ts.isIdentifier(property.name) ||
              property.name.text !== "controllers" ||
              !ts.isArrayLiteralExpression(property.initializer)
            ) {
              continue;
            }
            for (const controller of property.initializer.elements) {
              if (ts.isIdentifier(controller)) registered.add(controller.text);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return registered;
}

function requestImportBindings(file) {
  const named = new Map();
  const namespaces = new Set();
  file.forEachChild((node) => {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier) ||
      node.moduleSpecifier.text !== "./request" ||
      !node.importClause?.namedBindings ||
      node.importClause.isTypeOnly
    ) {
      return;
    }
    const bindings = node.importClause.namedBindings;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      return;
    }
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      named.set(
        element.name.text,
        element.propertyName?.text ?? element.name.text,
      );
    }
  });
  return { named, namespaces };
}

function isTransparentWrapper(node) {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isSatisfiesExpression(node)
  );
}

function isAllowedRequestNamespaceUse(identifier) {
  let current = identifier;
  const property = current.parent;
  if (
    !ts.isPropertyAccessExpression(property) ||
    property.expression !== current ||
    property.name.text !== "callAdminEndpointContract"
  ) {
    return false;
  }
  current = property;
  while (current.parent && isTransparentWrapper(current.parent)) {
    current = current.parent;
  }
  return (
    ts.isCallExpression(current.parent) && current.parent.expression === current
  );
}

function isAllowedNamedContractUse(identifier) {
  let current = identifier;
  while (current.parent && isTransparentWrapper(current.parent)) {
    current = current.parent;
  }
  return (
    ts.isCallExpression(current.parent) && current.parent.expression === current
  );
}

function isDeclarationOrImportIdentifier(identifier) {
  const parent = identifier.parent;
  return (
    (ts.isImportClause(parent) && parent.name === identifier) ||
    (ts.isImportSpecifier(parent) && parent.name === identifier) ||
    (ts.isNamespaceImport(parent) && parent.name === identifier) ||
    (ts.isFunctionDeclaration(parent) && parent.name === identifier) ||
    (ts.isClassDeclaration(parent) && parent.name === identifier) ||
    (ts.isEnumDeclaration(parent) && parent.name === identifier) ||
    (ts.isVariableDeclaration(parent) && parent.name === identifier) ||
    (ts.isParameter(parent) && parent.name === identifier) ||
    (ts.isBindingElement(parent) && parent.name === identifier)
  );
}

function isTypeOnlyUsage(identifier) {
  let current = identifier;
  while (current.parent) {
    if (ts.isTypeNode(current.parent)) return true;
    if (
      ts.isAsExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent)
    ) {
      return current !== current.parent.expression;
    }
    current = current.parent;
  }
  return false;
}

function isForbiddenMigrationRuntimeIdentifier(node) {
  return (
    ts.isIdentifier(node) &&
    ["fetch", "globalThis", "window"].includes(node.text) &&
    !isDeclarationOrImportIdentifier(node) &&
    !isTypeOnlyUsage(node) &&
    !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
  );
}

function checkMigrationApiImportAllowlist(root) {
  const failures = [];
  for (const path of MIGRATION_ADMIN_API_PATHS) {
    if (!pathExists(root, path)) continue;
    const file = parseTypeScript(path, readText(root, path));
    const requestNamespaces = new Set();
    const requestNamedContracts = new Set();
    file.forEachChild((node) => {
      if (
        !ts.isImportDeclaration(node) ||
        !ts.isStringLiteral(node.moduleSpecifier) ||
        !node.importClause ||
        node.importClause.isTypeOnly
      ) {
        return;
      }
      const moduleName = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (moduleName === "./request") {
        if (clause.name) {
          failures.push(
            `migration API import denied: ${path} imports default from ./request`,
          );
        }
        const bindings = clause.namedBindings;
        if (!bindings) return;
        if (ts.isNamespaceImport(bindings)) {
          requestNamespaces.add(bindings.name.text);
          return;
        }
        for (const element of bindings.elements) {
          if (element.isTypeOnly) continue;
          const importedName = element.propertyName?.text ?? element.name.text;
          if (importedName !== "callAdminEndpointContract") {
            failures.push(
              `migration API import denied: ${path} imports ${importedName} from ./request`,
            );
          } else {
            requestNamedContracts.add(element.name.text);
          }
        }
        return;
      }
      const importsNetworkTransport =
        moduleName === "axios" ||
        moduleName.includes("fetch") ||
        clause.name?.text === "axios" ||
        clause.name?.text === "fetch" ||
        (clause.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.some(
            (element) =>
              !element.isTypeOnly &&
              ["axios", "fetch"].includes(
                element.propertyName?.text ?? element.name.text,
              ),
          ));
      if (importsNetworkTransport) {
        failures.push(
          `migration API import denied: ${path} imports transport ${moduleName}`,
        );
      }
    });

    const visit = (node) => {
      if (
        ts.isIdentifier(node) &&
        requestNamespaces.has(node.text) &&
        !ts.isImportClause(node.parent) &&
        !ts.isNamespaceImport(node.parent) &&
        !isAllowedRequestNamespaceUse(node)
      ) {
        failures.push(
          `migration API namespace misuse: ${path} uses ${node.text} outside direct callAdminEndpointContract`,
        );
      }
      if (
        ts.isIdentifier(node) &&
        requestNamedContracts.has(node.text) &&
        !ts.isImportSpecifier(node.parent) &&
        !isTypeOnlyUsage(node) &&
        !isAllowedNamedContractUse(node)
      ) {
        failures.push(
          `migration API named contract misuse: ${path} uses ${node.text} outside direct callAdminEndpointContract`,
        );
      }
      if (isForbiddenMigrationRuntimeIdentifier(node)) {
        failures.push(
          `migration API network entry denied: ${path} uses ${node.text}`,
        );
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        failures.push(`migration API dynamic import denied: ${path}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return failures;
}

function importedNetworkBindings(file) {
  const bindings = new Map();
  file.forEachChild((node) => {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier) ||
      !node.importClause ||
      node.importClause.isTypeOnly
    ) {
      return;
    }
    const moduleName = node.moduleSpecifier.text;
    const clause = node.importClause;
    if (
      clause.name &&
      (moduleName === "axios" ||
        moduleName.includes("fetch") ||
        clause.name.text === "fetch")
    ) {
      bindings.set(
        clause.name.text,
        moduleName === "axios" ? "axios" : "fetch",
      );
    }
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      if (moduleName === "axios") {
        bindings.set(clause.namedBindings.name.text, "axios");
      }
    } else if (
      clause.namedBindings &&
      ts.isNamedImports(clause.namedBindings)
    ) {
      for (const element of clause.namedBindings.elements) {
        if (element.isTypeOnly) continue;
        const importedName = element.propertyName?.text ?? element.name.text;
        if (importedName === "fetch" || importedName === "axios") {
          bindings.set(element.name.text, importedName);
        }
      }
    }
  });
  return bindings;
}

function declaredValueNames(file) {
  const names = new Set();
  const addBindingName = (binding) => {
    if (ts.isIdentifier(binding)) names.add(binding.text);
    if (
      ts.isObjectBindingPattern(binding) ||
      ts.isArrayBindingPattern(binding)
    ) {
      for (const element of binding.elements) {
        if (ts.isBindingElement(element)) addBindingName(element.name);
      }
    }
  };
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      node.importClause &&
      !node.importClause.isTypeOnly
    ) {
      if (node.importClause.name) names.add(node.importClause.name.text);
      const bindings = node.importClause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings))
        names.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (!element.isTypeOnly) names.add(element.name.text);
        }
      }
    }
    if (ts.isVariableDeclaration(node)) addBindingName(node.name);
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name
    ) {
      names.add(node.name.text);
    }
    if (ts.isParameter(node)) addBindingName(node.name);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

function unwrapTransparentExpression(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyAccessPath(expression) {
  const names = [];
  let current = unwrapTransparentExpression(expression);
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    if (ts.isPropertyAccessExpression(current)) {
      names.unshift(current.name.text);
      current = unwrapTransparentExpression(current.expression);
      continue;
    }
    const argument = current.argumentExpression
      ? unwrapTransparentExpression(current.argumentExpression)
      : undefined;
    if (!argument || !ts.isStringLiteral(argument)) return undefined;
    names.unshift(argument.text);
    current = unwrapTransparentExpression(current.expression);
  }
  if (!ts.isIdentifier(current)) return undefined;
  names.unshift(current.text);
  return names;
}

function migrationNetworkEntry(
  expression,
  requestBindings,
  importedBindings,
  declaredNames,
) {
  const path = propertyAccessPath(expression);
  if (!path) return undefined;
  const [root, ...properties] = path;
  const importedRequest = requestBindings.named.get(root);
  if (importedRequest) {
    return [importedRequest, ...properties].join(".");
  }
  if (requestBindings.namespaces.has(root)) {
    return properties[0] === "request"
      ? ["request", ...properties].join(".")
      : properties.join(".");
  }
  const importedNetwork = importedBindings.get(root);
  if (importedNetwork) {
    return [importedNetwork, ...properties].join(".");
  }
  if (root === "fetch" && properties.length === 0 && !declaredNames.has(root)) {
    return "fetch";
  }
  return undefined;
}

function migrationNetworkCalls(root) {
  const calls = [];
  for (const path of MIGRATION_ADMIN_API_PATHS) {
    if (!pathExists(root, path)) continue;
    const file = parseTypeScript(path, readText(root, path));
    const requestBindings = requestImportBindings(file);
    const importedBindings = importedNetworkBindings(file);
    const declaredNames = declaredValueNames(file);
    const visit = (node, enclosingFunction) => {
      let currentFunction = enclosingFunction;
      if (
        (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
        node.name &&
        ts.isIdentifier(node.name)
      ) {
        currentFunction = node.name.text;
      }
      if (ts.isCallExpression(node) && !isStaticallyDead(node)) {
        const entry = migrationNetworkEntry(
          node.expression,
          requestBindings,
          importedBindings,
          declaredNames,
        );
        if (entry) {
          calls.push({
            path,
            method: currentFunction,
            entry,
            contract:
              entry === "callAdminEndpointContract" &&
              node.arguments.length > 0 &&
              ts.isIdentifier(unwrapTransparentExpression(node.arguments[0]))
                ? unwrapTransparentExpression(node.arguments[0]).text
                : undefined,
          });
        }
      }
      ts.forEachChild(node, (child) => visit(child, currentFunction));
    };
    visit(file, undefined);
  }
  return calls;
}

function requestHelperName(expression, bindings) {
  if (ts.isIdentifier(expression)) return bindings.named.get(expression.text);
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    bindings.namespaces.has(expression.expression.text)
  ) {
    return expression.name.text;
  }
  return undefined;
}

function requestHelperCalls(root) {
  const calls = [];
  for (const path of listFiles(root, ADMIN_API_DIRECTORY)) {
    if (path.endsWith(".spec.ts")) continue;
    const file = parseTypeScript(path, readText(root, path));
    const bindings = requestImportBindings(file);
    const visit = (node, enclosingFunction) => {
      let currentFunction = enclosingFunction;
      if (
        (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
        node.name &&
        ts.isIdentifier(node.name)
      ) {
        currentFunction = node.name.text;
      }
      if (
        ts.isCallExpression(node) &&
        REQUEST_HELPERS.has(requestHelperName(node.expression, bindings)) &&
        !isStaticallyDead(node)
      ) {
        calls.push({
          path,
          method: currentFunction,
          helper: requestHelperName(node.expression, bindings),
          contract:
            requestHelperName(node.expression, bindings) ===
              "callAdminEndpointContract" &&
            node.arguments.length > 0 &&
            ts.isIdentifier(node.arguments[0])
              ? node.arguments[0].text
              : undefined,
        });
      }
      ts.forEachChild(node, (child) => visit(child, currentFunction));
    };
    visit(file, undefined);
  }
  return calls;
}

function contractCalls(root) {
  return requestHelperCalls(root).filter(
    (call) => call.helper === "callAdminEndpointContract" && call.contract,
  );
}

function rawAdminHelperCalls(root) {
  return requestHelperCalls(root).filter(
    (call) => call.helper !== "callAdminEndpointContract",
  );
}

function isStaticallyDead(node) {
  let current = node;
  while (current.parent) {
    const parent = current.parent;
    if (
      ts.isIfStatement(parent) &&
      parent.expression.kind === ts.SyntaxKind.FalseKeyword &&
      isDescendantOf(current, parent.thenStatement)
    ) {
      return true;
    }
    if (isAfterUnconditionalExit(current, parent)) return true;
    current = parent;
  }
  return false;
}

function isAfterUnconditionalExit(node, parent) {
  if (!ts.isBlock(parent)) return false;
  const statement = findContainingStatement(node, parent);
  if (!statement) return false;
  const index = parent.statements.indexOf(statement);
  return parent.statements
    .slice(0, index)
    .some(
      (candidate) =>
        ts.isReturnStatement(candidate) || ts.isThrowStatement(candidate),
    );
}

function findContainingStatement(node, block) {
  let current = node;
  while (current && current.parent !== block) current = current.parent;
  return current && ts.isStatement(current) ? current : undefined;
}

function isDescendantOf(node, ancestor) {
  let current = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function checkTryOnContractCoverage(root) {
  const failures = [];
  const definitions = contractDefinitions(root);
  const providers = decoratedMethods(
    root,
    "apps/service-api/src",
    "AdminEndpointContract",
  );
  const registered = registeredControllers(root);
  const requestCalls = requestHelperCalls(root);
  const migrationCalls = migrationNetworkCalls(root);
  const migrationImportFailures = checkMigrationApiImportAllowlist(root);
  const callers = requestCalls.filter(
    (call) => call.helper === "callAdminEndpointContract" && call.contract,
  );
  const callerHits = [];
  const providerHits = [];

  const targetsTryOn =
    definitions.size > 0 ||
    providers.some((candidate) =>
      TRY_ON_CONTRACT_NAMES.includes(candidate.contract),
    ) ||
    callers.some((candidate) =>
      TRY_ON_CONTRACT_NAMES.includes(candidate.contract),
    );
  if (!targetsTryOn) {
    return { failures, callerHits, providerHits };
  }

  failures.push(...migrationImportFailures);

  for (const call of migrationCalls) {
    if (call.entry === "callAdminEndpointContract") continue;
    failures.push(
      `migration API network entry denied: ${call.path}#${call.method} uses ${call.entry}`,
    );
  }

  for (const name of TRY_ON_CONTRACT_NAMES) {
    const expected = TRY_ON_CONTRACT_EXPECTATIONS[name];
    const definition = definitions.get(name);
    if (!definition) {
      failures.push(`try-on contract definition missing: ${name}`);
    } else {
      const missingFields = TRY_ON_CONTRACT_FIELDS.filter(
        (field) => !(field in definition.values),
      );
      if (missingFields.length > 0) {
        failures.push(
          `try-on contract definition incomplete: ${name} missing ${missingFields.join(", ")}`,
        );
      }
      const invalidSchemas = [...definition.invalidSchemaFields];
      if (invalidSchemas.length > 0) {
        failures.push(
          `try-on contract definition schema escape: ${name} uses unknown schema for ${invalidSchemas.join(", ")}`,
        );
      }
      for (const [field, expectedReferences] of Object.entries(
        expected.schemaReferences,
      )) {
        const expression = definition.values[field];
        if (
          field in definition.values &&
          (!ts.isIdentifier(expression) ||
            !expectedReferences.includes(expression.text))
        ) {
          failures.push(
            `try-on contract definition schema drift: ${name} ${field} expected ${expectedReferences.join(" or ")}`,
          );
        }
      }
      if (stringLiteralValue(definition.values.method) !== expected.method) {
        failures.push(
          `try-on contract method drift: ${name} expected ${expected.method}`,
        );
      }
      if (stringLiteralValue(definition.values.path) !== expected.path) {
        failures.push(
          `try-on contract path drift: ${name} expected ${expected.path}`,
        );
      }
    }

    const provider = providers.find(
      (candidate) =>
        candidate.contract === name &&
        candidate.method === expected.providerMethod,
    );
    if (!provider) {
      failures.push(`try-on endpoint contract provider missing: ${name}`);
    } else {
      if (!provider.controller || !registered.has(provider.controller)) {
        failures.push(
          `try-on endpoint contract provider controller unregistered: ${name}`,
        );
      } else {
        providerHits.push(name);
      }
    }

    const callerPath = PRODUCT_CATALOG_CONTRACT_NAMES.has(name)
      ? "apps/admin-ui/src/api/products.ts"
      : "apps/admin-ui/src/api/try-on-garments.ts";
    const callerNetworkCalls = migrationCalls.filter(
      (candidate) =>
        candidate.path === callerPath &&
        expected.callerMethods.includes(candidate.method),
    );
    const matchingCalls = callerNetworkCalls.filter(
      (candidate) =>
        candidate.entry === "callAdminEndpointContract" &&
        candidate.contract === name,
    );
    if (matchingCalls.length === 0) {
      failures.push(`try-on endpoint contract caller missing: ${name}`);
    } else if (matchingCalls.length !== 1 || callerNetworkCalls.length !== 1) {
      failures.push(`try-on endpoint contract caller ambiguous: ${name}`);
    } else if (
      callerNetworkCalls.some((candidate) => candidate.contract !== name)
    ) {
      failures.push(`try-on endpoint contract caller identity drift: ${name}`);
    } else {
      callerHits.push(name);
    }
    const rawBypasses = callerNetworkCalls.filter(
      (candidate) => candidate.entry !== "callAdminEndpointContract",
    );
    if (rawBypasses.length > 0) {
      failures.push(
        `try-on endpoint contract caller raw helper bypass: ${name} uses ${rawBypasses.map((candidate) => candidate.entry).join(", ")}`,
      );
    }
  }

  const uploadSource = pathExists(
    root,
    "packages/shared/src/schemas/try-on-garments.ts",
  )
    ? readText(root, "packages/shared/src/schemas/try-on-garments.ts")
    : "";
  if (
    /adminTryOnGarmentUploadContract[\s\S]*z\.unknown\s*\(\s*\)/.test(
      uploadSource,
    )
  ) {
    failures.push("try-on upload contract body must not use z.unknown");
  }
  return { failures, callerHits, providerHits };
}

function stringLiteralValue(value) {
  return value && ts.isStringLiteral(value) ? value.text : undefined;
}

function functionUsesWriteHelper(fn) {
  return WRITE_CALL_PATTERN.test(fn.body);
}

function functionUsesBroadQuery(parameters) {
  return /(?:^|,)\s*query\s*\??\s*:\s*Record\s*<\s*string\s*,\s*unknown\s*>/.test(
    parameters,
  );
}

function bodyParameterType(parameters) {
  const match = /\b(?:body|input)\??\s*:/g.exec(parameters);
  if (!match) return "";

  const typeStart = match.index + match[0].length;
  let angleDepth = 0;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  for (let index = typeStart; index < parameters.length; index += 1) {
    const character = parameters[index];
    if (character === "<") angleDepth += 1;
    if (character === ">" && angleDepth > 0) angleDepth -= 1;
    if (character === "(") parenDepth += 1;
    if (character === ")" && parenDepth > 0) parenDepth -= 1;
    if (character === "{") braceDepth += 1;
    if (character === "}" && braceDepth > 0) braceDepth -= 1;
    if (character === "[") bracketDepth += 1;
    if (character === "]" && bracketDepth > 0) bracketDepth -= 1;
    if (
      character === "," &&
      angleDepth === 0 &&
      parenDepth === 0 &&
      braceDepth === 0 &&
      bracketDepth === 0
    ) {
      return parameters.slice(typeStart, index).trim();
    }
  }
  return parameters.slice(typeStart).trim();
}

function isLocalBodyType(typeText) {
  if (!typeText) return false;
  if (typeText.startsWith("{")) return true;
  if (SHARED_BODY_TYPE_PATTERN.test(typeText)) return false;

  const typeNames = typeText.match(/\b[A-Z][A-Za-z0-9_]*\b/g) ?? [];
  return typeNames.some((typeName) => !LOCAL_TYPE_UTILITY_NAMES.has(typeName));
}

function checkWriteCaller(caller, fn) {
  const failures = [];
  const calls = helperCalls(fn.body);
  for (const call of calls) {
    if (WRITE_HELPERS.has(call)) {
      failures.push(`admin write caller uses unbound ${call}: ${caller}`);
    }
  }
  if (!calls.some((call) => CONTRACT_WRITE_HELPERS.has(call))) {
    failures.push(`admin write caller missing schema-bound helper: ${caller}`);
  }

  const bodyType = bodyParameterType(fn.parameters);
  if (isLocalBodyType(bodyType)) {
    failures.push(`admin write caller uses local body type: ${caller}`);
  }
  if (BROAD_TYPE_PATTERN.test(bodyType)) {
    failures.push(`admin write caller uses broad body type: ${caller}`);
  }
  return failures;
}

function indexWriteCallers(root) {
  const callers = new Map();
  for (const path of listFiles(root, ADMIN_API_DIRECTORY)) {
    if (EXCLUDED_API_FILES.has(path) || path.endsWith(".spec.ts")) continue;
    const source = readText(root, path);
    for (const fn of extractFunctions(source)) {
      if (!functionUsesWriteHelper(fn)) continue;
      callers.set(`${path}#${fn.name}`, { path, fn });
    }
  }
  return callers;
}

function checkWriteModuleQueryTypes(root, writeModulePaths) {
  const failures = [];

  for (const path of writeModulePaths) {
    if (!pathExists(root, path)) continue;
    const source = readText(root, path);
    for (const fn of extractFunctions(source)) {
      if (!functionUsesBroadQuery(fn.parameters)) continue;
      failures.push(
        `admin api write module uses broad query type: ${path}#${fn.name}`,
      );
    }
  }

  return failures;
}

export function checkAdminApiContracts(options = {}) {
  const root = options.root ?? process.cwd();
  const failures = [];
  const checks = [];
  const callers = indexWriteCallers(root);
  const writeModulePaths = new Set(
    [...callers.values()].map((indexed) => indexed.path),
  );

  for (const [caller, indexed] of callers) {
    failures.push(...checkWriteCaller(caller, indexed.fn));
  }
  failures.push(...checkWriteModuleQueryTypes(root, writeModulePaths));
  const tryOnCoverage = checkTryOnContractCoverage(root);
  failures.push(...tryOnCoverage.failures);

  checks.push({
    name: "admin-writes-use-schema-bound-contracts",
    passed: !failures.some((failure) =>
      failure.startsWith("admin write caller"),
    ),
    detail: "admin writes use schema-bound helpers and shared body types",
  });
  checks.push({
    name: "try-on-providers-and-callers-share-complete-contracts",
    passed: tryOnCoverage.failures.length === 0,
    detail: `callers=${tryOnCoverage.callerHits.length}, providers=${tryOnCoverage.providerHits.length}`,
  });
  checks.push({
    name: "admin-write-modules-avoid-broad-query-shortcuts",
    passed: !failures.some((failure) =>
      failure.startsWith("admin api write module uses broad query type"),
    ),
    detail: "admin API modules with writes use shared query contracts",
  });

  return {
    ok: failures.length === 0,
    checks,
    failures,
    writeCallers: [...callers.keys()].sort(),
    tryOnCoverage,
  };
}

function printResult(result) {
  for (const check of result.checks) {
    const mark = check.passed ? "ok" : "not ok";
    console.log(`${mark} - ${check.name}: ${check.detail}`);
  }
  for (const failure of result.failures) {
    console.error(`not ok - ${failure}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rootFlagIndex = process.argv.indexOf("--root");
  const root =
    rootFlagIndex === -1 ? process.cwd() : process.argv[rootFlagIndex + 1];
  const result = checkAdminApiContracts({ root });
  printResult(result);
  if (!result.ok) {
    process.exitCode = 1;
  }
}
