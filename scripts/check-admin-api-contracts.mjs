#!/usr/bin/env node

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ADMIN_API_DIRECTORY = "apps/admin-ui/src/api";
const SHARED_SCHEMA_DIRECTORY = "packages/shared/src/schemas";
const CONTRACT_DEFINITION_HELPER = "defineAdminEndpointContract";
const CONTRACT_MANIFEST_HELPER = "defineAdminContractManifest";
const EXCLUDED_API_FILES = new Set(["apps/admin-ui/src/api/request.ts"]);
const ROUTE_DECORATORS = new Set(["Get", "Post", "Patch", "Put", "Delete"]);
const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const CONTRACT_FIELDS = [
  "method",
  "path",
  "pathParamsSchema",
  "querySchema",
  "bodySchema",
  "responseSchema",
];

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

function parseTypeScript(path, source) {
  return ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function stringLiteralValue(value) {
  return value && ts.isStringLiteral(value) ? value.text : undefined;
}

function arrayOfStringLiterals(node) {
  if (!node || !ts.isArrayLiteralExpression(node)) return undefined;
  const values = [];
  for (const element of node.elements) {
    const value = stringLiteralValue(element);
    if (value === undefined) return undefined;
    values.push(value);
  }
  return values;
}

function objectLiteralRecord(node) {
  if (!node || !ts.isObjectLiteralExpression(node)) return undefined;
  const record = {};
  for (const property of node.properties) {
    const name =
      ts.isPropertyAssignment(property) ||
      ts.isShorthandPropertyAssignment(property)
        ? ts.isIdentifier(property.name)
          ? property.name.text
          : ts.isStringLiteral(property.name)
            ? property.name.text
            : undefined
        : undefined;
    if (!name) continue;
    record[name] = ts.isShorthandPropertyAssignment(property)
      ? property.name
      : property.initializer;
  }
  return record;
}

function topLevelVariableInitializers(file) {
  const found = [];
  file.forEachChild((statement) => {
    if (!ts.isVariableStatement(statement)) return;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
        continue;
      }
      found.push({
        name: declaration.name.text,
        initializer: declaration.initializer,
      });
    }
  });
  return found;
}

function callWithIdentifier(expression, helperName) {
  if (
    !ts.isCallExpression(expression) ||
    !ts.isIdentifier(expression.expression) ||
    expression.expression.text !== helperName ||
    expression.arguments.length !== 1
  ) {
    return undefined;
  }
  return expression.arguments[0];
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

function contractDefinitions(root) {
  const definitions = new Map();
  for (const path of listFiles(root, SHARED_SCHEMA_DIRECTORY)) {
    const source = readText(root, path);
    const file = parseTypeScript(path, source);
    for (const { name, initializer } of topLevelVariableInitializers(file)) {
      const argument = callWithIdentifier(
        initializer,
        CONTRACT_DEFINITION_HELPER,
      );
      if (!argument) continue;
      const values = objectLiteralRecord(argument);
      if (!values) continue;
      const invalidSchemaFields = new Set();
      for (const field of [
        "pathParamsSchema",
        "querySchema",
        "bodySchema",
        "responseSchema",
      ]) {
        if (field in values && isUnknownSchemaExpression(values[field])) {
          invalidSchemaFields.add(field);
        }
      }
      definitions.set(name, { path, values, invalidSchemaFields });
    }
  }
  return definitions;
}

function manifestEntries(root) {
  const manifests = [];
  for (const path of listFiles(root, SHARED_SCHEMA_DIRECTORY)) {
    const source = readText(root, path);
    const file = parseTypeScript(path, source);
    for (const { name, initializer } of topLevelVariableInitializers(file)) {
      const argument = callWithIdentifier(
        initializer,
        CONTRACT_MANIFEST_HELPER,
      );
      if (!argument) continue;
      const values = objectLiteralRecord(argument);
      if (!values) continue;
      const slice = stringLiteralValue(values.slice);
      const controllerPaths = arrayOfStringLiterals(values.controllerPaths);
      const callerPaths = arrayOfStringLiterals(values.callerPaths);
      const contractsRecord = objectLiteralRecord(values.contracts);
      if (
        slice === undefined ||
        controllerPaths === undefined ||
        callerPaths === undefined ||
        contractsRecord === undefined
      ) {
        throw new Error(`invalid admin contract manifest: ${path}#${name}`);
      }
      const contracts = {};
      for (const [contractName, entryExpression] of Object.entries(
        contractsRecord,
      )) {
        const entry = objectLiteralRecord(entryExpression);
        if (!entry) {
          throw new Error(
            `invalid admin contract manifest entry: ${path}#${name}.${contractName}`,
          );
        }
        const method = stringLiteralValue(entry.method);
        const pathValue = stringLiteralValue(entry.path);
        const providerMethod = stringLiteralValue(entry.providerMethod);
        if (!method || !pathValue || !providerMethod) {
          throw new Error(
            `invalid admin contract manifest entry: ${path}#${name}.${contractName}`,
          );
        }
        const schemaReferencesNode = objectLiteralRecord(
          entry.schemaReferences,
        );
        const schemaReferences = schemaReferencesNode
          ? Object.fromEntries(
              Object.entries(schemaReferencesNode).map(
                ([field, expression]) => [
                  field,
                  arrayOfStringLiterals(expression),
                ],
              ),
            )
          : undefined;
        contracts[contractName] = {
          method,
          path: pathValue,
          providerMethod,
          callerPath: stringLiteralValue(entry.callerPath),
          callerMethods: arrayOfStringLiterals(entry.callerMethods),
          schemaReferences,
        };
      }
      manifests.push({
        name,
        path,
        slice,
        controllerPaths,
        callerPaths,
        contracts,
      });
    }
  }
  return manifests;
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

function decoratedMethods(root, directory, decoratorName) {
  const methods = [];
  for (const path of listFiles(root, directory)) {
    if (!path.endsWith(".controller.ts")) continue;
    const file = parseTypeScript(path, readText(root, path));
    const visit = (node) => {
      if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
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

function unwrapTransparentExpression(expression) {
  let current = expression;
  while (isTransparentWrapper(current)) current = current.expression;
  return current;
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

function checkMigrationApiImportAllowlist(root, paths) {
  const failures = [];
  for (const path of paths) {
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

function migrationNetworkCalls(root, paths) {
  const calls = [];
  for (const path of paths) {
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

function checkMigratedProviderBareRoutes(root, manifest) {
  const failures = [];
  for (const path of manifest.controllerPaths) {
    if (!pathExists(root, path)) continue;
    const file = parseTypeScript(path, readText(root, path));
    const visit = (node) => {
      if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
        const decoratorNames = decoratorsOf(node)
          .map((decorator) => decoratorCall(decorator)?.name)
          .filter(Boolean);
        const hasRoute = decoratorNames.some((name) =>
          ROUTE_DECORATORS.has(name),
        );
        const isPublic = decoratorNames.includes("Public");
        const hasContract = decoratorNames.includes("AdminEndpointContract");
        if (hasRoute && !isPublic && !hasContract) {
          failures.push(
            `${manifest.slice} provider bare admin route: ${path}#${node.name.text} lacks AdminEndpointContract`,
          );
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return failures;
}

function findExportedCallerFunction(file, methodName) {
  let found;
  file.forEachChild((statement) => {
    if (found) return;
    if (ts.isFunctionDeclaration(statement)) {
      if (!statement.name || statement.name.text !== methodName) return;
      if (
        statement.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        )
      ) {
        found = statement;
      }
      return;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        if (declaration.name.text !== methodName) continue;
        if (
          declaration.initializer &&
          (ts.isArrowFunction(declaration.initializer) ||
            ts.isFunctionExpression(declaration.initializer)) &&
          statement.modifiers?.some(
            (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
          )
        ) {
          found = declaration.initializer;
        }
      }
    }
  });
  return found;
}

function zInputTypeQueryReference(typeNode) {
  const type = unwrapTransparentExpression(typeNode);
  if (!ts.isTypeReferenceNode(type) || type.typeArguments?.length !== 1) {
    return undefined;
  }
  const typeName = type.typeName;
  const isZInput =
    (ts.isQualifiedName(typeName) &&
      ts.isIdentifier(typeName.left) &&
      typeName.left.text === "z" &&
      typeName.right.text === "input") ||
    (ts.isPropertyAccessExpression(typeName) &&
      ts.isIdentifier(typeName.expression) &&
      typeName.expression.text === "z" &&
      typeName.name.text === "input");
  if (!isZInput) return undefined;
  const argument = type.typeArguments[0];
  if (!ts.isTypeQueryNode(argument)) return undefined;
  if (ts.isIdentifier(argument.exprName)) {
    return { kind: "schema", name: argument.exprName.text };
  }
  if (
    (ts.isPropertyAccessExpression(argument.exprName) &&
      ts.isIdentifier(argument.exprName.expression) &&
      argument.exprName.name.text === "bodySchema") ||
    (ts.isQualifiedName(argument.exprName) &&
      ts.isIdentifier(argument.exprName.left) &&
      argument.exprName.right.text === "bodySchema")
  ) {
    const contract = ts.isPropertyAccessExpression(argument.exprName)
      ? argument.exprName.expression
      : argument.exprName.left;
    return {
      kind: "contractBody",
      contract: contract.text,
    };
  }
  return undefined;
}

function checkCallerWriteBodySchema(
  file,
  methodName,
  contractName,
  bodySchemaIdentifier,
) {
  const failures = [];
  const fn = findExportedCallerFunction(file, methodName);
  if (!fn) return failures;
  for (const parameter of fn.parameters) {
    if (
      !ts.isIdentifier(parameter.name) ||
      !["body", "input"].includes(parameter.name.text)
    ) {
      continue;
    }
    if (!parameter.type) {
      failures.push(
        `caller write body type underived: ${methodName} body has no type`,
      );
      continue;
    }
    const reference = zInputTypeQueryReference(parameter.type);
    const derivedFromSchema =
      reference?.kind === "schema" && reference.name === bodySchemaIdentifier;
    const derivedFromContract =
      reference?.kind === "contractBody" && reference.contract === contractName;
    if (!derivedFromSchema && !derivedFromContract) {
      failures.push(
        `caller write body type drift: ${methodName} body expected z.input<typeof ${bodySchemaIdentifier}>`,
      );
    }
  }
  return failures;
}

function checkContractSliceCoverage(root, manifest, context) {
  const failures = [];
  const callerHits = [];
  const providerHits = [];
  const { definitions, providers, registered } = context;
  const migrationCalls = migrationNetworkCalls(root, manifest.callerPaths);

  failures.push(
    ...checkMigrationApiImportAllowlist(root, manifest.callerPaths),
  );

  for (const call of migrationCalls) {
    if (call.entry === "callAdminEndpointContract") continue;
    failures.push(
      `migration API network entry denied: ${call.path}#${call.method} uses ${call.entry}`,
    );
  }

  for (const [name, entry] of Object.entries(manifest.contracts)) {
    const definition = definitions.get(name);
    if (!definition) {
      failures.push(`${manifest.slice} contract definition missing: ${name}`);
    } else {
      const missingFields = CONTRACT_FIELDS.filter(
        (field) => !(field in definition.values),
      );
      if (missingFields.length > 0) {
        failures.push(
          `${manifest.slice} contract definition incomplete: ${name} missing ${missingFields.join(", ")}`,
        );
      }
      const invalidSchemas = [...definition.invalidSchemaFields];
      if (invalidSchemas.length > 0) {
        failures.push(
          `${manifest.slice} contract definition schema escape: ${name} uses unknown schema for ${invalidSchemas.join(", ")}`,
        );
      }
      if (stringLiteralValue(definition.values.method) !== entry.method) {
        failures.push(
          `${manifest.slice} contract method drift: ${name} expected ${entry.method}`,
        );
      }
      if (stringLiteralValue(definition.values.path) !== entry.path) {
        failures.push(
          `${manifest.slice} contract path drift: ${name} expected ${entry.path}`,
        );
      }
      if (entry.schemaReferences) {
        for (const [field, expectedReferences] of Object.entries(
          entry.schemaReferences,
        )) {
          const expression = definition.values[field];
          if (
            field in definition.values &&
            (!ts.isIdentifier(expression) ||
              !expectedReferences.includes(expression.text))
          ) {
            failures.push(
              `${manifest.slice} contract definition schema drift: ${name} ${field} expected ${expectedReferences.join(" or ")}`,
            );
          }
        }
      }
    }

    const provider = providers.find(
      (candidate) =>
        candidate.contract === name &&
        candidate.method === entry.providerMethod,
    );
    if (!provider) {
      failures.push(
        `${manifest.slice} endpoint contract provider missing: ${name}`,
      );
    } else if (!provider.controller || !registered.has(provider.controller)) {
      failures.push(
        `${manifest.slice} endpoint contract provider controller unregistered: ${name}`,
      );
    } else {
      providerHits.push(name);
    }

    if (entry.callerPath && entry.callerMethods) {
      const callerNetworkCalls = migrationCalls.filter(
        (candidate) =>
          candidate.path === entry.callerPath &&
          entry.callerMethods.includes(candidate.method),
      );
      const matchingCalls = callerNetworkCalls.filter(
        (candidate) =>
          candidate.entry === "callAdminEndpointContract" &&
          candidate.contract === name,
      );
      if (matchingCalls.length === 0) {
        failures.push(
          `${manifest.slice} endpoint contract caller missing: ${name}`,
        );
      } else if (matchingCalls.length !== 1) {
        failures.push(
          `${manifest.slice} endpoint contract caller ambiguous: ${name}`,
        );
      } else {
        callerHits.push(name);
      }
      const rawBypasses = callerNetworkCalls.filter(
        (candidate) => candidate.entry !== "callAdminEndpointContract",
      );
      if (rawBypasses.length > 0) {
        failures.push(
          `${manifest.slice} endpoint contract caller raw helper bypass: ${name} uses ${rawBypasses.map((candidate) => candidate.entry).join(", ")}`,
        );
      }
    }

    if (
      entry.callerPath &&
      entry.callerMethods &&
      WRITE_METHODS.has(entry.method) &&
      definition &&
      ts.isIdentifier(definition.values.bodySchema)
    ) {
      const callerFile = parseTypeScript(
        entry.callerPath,
        readText(root, entry.callerPath),
      );
      for (const methodName of entry.callerMethods) {
        failures.push(
          ...checkCallerWriteBodySchema(
            callerFile,
            methodName,
            name,
            definition.values.bodySchema.text,
          ),
        );
      }
    }
  }

  const bareRouteFailures = checkMigratedProviderBareRoutes(root, manifest);
  failures.push(...bareRouteFailures);
  return { failures, callerHits, providerHits, bareRouteFailures };
}

function uncoveredAdminBareRoutes(root, manifests) {
  const lockedControllers = new Set(
    manifests.flatMap((manifest) => manifest.controllerPaths),
  );
  const uncovered = [];
  for (const path of listFiles(root, "apps/service-api/src")) {
    if (!path.endsWith(".controller.ts")) continue;
    if (lockedControllers.has(path)) continue;
    const file = parseTypeScript(path, readText(root, path));
    const visit = (node) => {
      if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
        const decoratorNames = decoratorsOf(node)
          .map((decorator) => decoratorCall(decorator)?.name)
          .filter(Boolean);
        const hasRoute = decoratorNames.some((name) =>
          ROUTE_DECORATORS.has(name),
        );
        const isPublic = decoratorNames.includes("Public");
        const hasContract = decoratorNames.includes("AdminEndpointContract");
        if (hasRoute && !isPublic && !hasContract) {
          uncovered.push(`${path}#${node.name.text}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return uncovered.sort();
}

function uncoveredLegacyCallerModules(root, manifests) {
  const lockedCallers = new Set(
    manifests.flatMap((manifest) => manifest.callerPaths),
  );
  const uncovered = [];
  for (const path of listFiles(root, ADMIN_API_DIRECTORY)) {
    if (path.endsWith(".spec.ts") || EXCLUDED_API_FILES.has(path)) continue;
    if (lockedCallers.has(path)) continue;
    const file = parseTypeScript(path, readText(root, path));
    const bindings = requestImportBindings(file);
    const runtimeRequestNames = [...bindings.named.values()].filter(
      (name) => name !== "callAdminEndpointContract",
    );
    const hasNetworkTransport =
      importedNetworkBindings(file).size > 0 || bindings.namespaces.size > 0;
    if (runtimeRequestNames.length > 0 || hasNetworkTransport) {
      uncovered.push(path);
    }
  }
  return uncovered.sort();
}

export function checkAdminApiContracts(options = {}) {
  const root = options.root ?? process.cwd();
  const failures = [];
  const manifests = manifestEntries(root);
  const definitions = contractDefinitions(root);
  const providers = decoratedMethods(
    root,
    "apps/service-api/src",
    "AdminEndpointContract",
  );
  const registered = registeredControllers(root);
  const coverage = {};
  const checks = [];

  for (const manifest of manifests) {
    const result = checkContractSliceCoverage(root, manifest, {
      definitions,
      providers,
      registered,
    });
    coverage[manifest.slice] = result;
    failures.push(...result.failures);
    checks.push({
      name: `${manifest.slice}-providers-and-callers-share-complete-contracts`,
      passed: result.failures.length === 0,
      detail: `callers=${result.callerHits.length}, providers=${result.providerHits.length}, bareRoutes=${result.bareRouteFailures.length}`,
    });
  }

  const backlog = {
    adminBareRoutes: uncoveredAdminBareRoutes(root, manifests),
    legacyHelperModules: uncoveredLegacyCallerModules(root, manifests),
  };

  return {
    ok: failures.length === 0,
    checks,
    failures,
    coverage,
    backlog,
    manifests: manifests.map((manifest) => manifest.slice),
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
  for (const route of result.backlog.adminBareRoutes) {
    console.log(`info - unmigrated admin provider route: ${route}`);
  }
  for (const modulePath of result.backlog.legacyHelperModules) {
    console.log(`info - unmigrated admin api module: ${modulePath}`);
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
