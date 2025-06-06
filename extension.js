const vscode = require('vscode');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } = require('vscode-languageclient/node');

// Save terminal reference
let OnionTerminal = null;
// Save LSP client reference
let langClient = null;

/**
 * Called when extension is activated
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    console.log('Onion extension activated');    // Start LSP server
    startLSP(context);
    // Register command to run Onion files
    let disposable = vscode.commands.registerCommand('Onion.run', function () {
        runOnionFile();
    });
    // Add test command
    let testDisposable = vscode.commands.registerCommand('Onion.diagnose', () => {
        // Get current active editor and document
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('No active editor');
            return;
        }        const document = editor.document;
        const report = [
            `File name: ${document.fileName}`,
            `Language ID: ${document.languageId}`,
            `Extension: ${path.extname(document.fileName)}`,
            `LSP client status: ${langClient ? 'Started' : 'Not started'}`,
            `Auto completion status: ${langClient && langClient.initializeResult && 
                langClient.initializeResult.capabilities.completionProvider ? 'Available' : 'Not available'}`,
            `Semantic tokens status: ${langClient && langClient.initializeResult && 
                langClient.initializeResult.capabilities.semanticTokensProvider ? 'Available' : 'Not available'}`
        ];

        console.log('Onion diagnostic report:\n' + report.join('\n'));
        vscode.window.showInformationMessage('Onion diagnostic report generated, please check console');

        // Try to set file as Onion type
        if (document.languageId !== 'Onion') {
            vscode.window.showInformationMessage('Current file is not Onion type, trying to set...');
            vscode.languages.setTextDocumentLanguage(document, 'Onion')
                .then(() => {
                    vscode.window.showInformationMessage('Successfully set as Onion type');
                })
                .catch(err => {
                    vscode.window.showErrorMessage(`Failed to set: ${err.message}`);
                });
        }        // If LSP client is started, try to send test notification
        if (langClient) {
            // Send test notification
            langClient.sendNotification('textDocument/didChange', {
                textDocument: {
                    uri: document.uri.toString(),
                    version: document.version
                },
                contentChanges: [{ text: document.getText() }]
            });
            console.log('Test notification sent to LSP server');
            
            // Manually request semantic tokens
            langClient.sendRequest('textDocument/semanticTokens/full', {
                textDocument: {
                    uri: document.uri.toString()
                }
            }).then(tokens => {
                console.log('Received semantic tokens:', tokens ? 'Has data' : 'No data');
                if (tokens) {
                    console.log('Token data first 100 items:', JSON.stringify(tokens).substring(0, 500) + '...');
                }
            }).catch(err => {
                console.error('Failed to request semantic tokens:', err);
            });
        }        // If LSP client is started, try to manually trigger auto completion function test
        if (langClient && langClient.initializeResult && 
            langClient.initializeResult.capabilities.completionProvider) {
            console.log('Auto completion feature configured, can use completion hints');
            vscode.window.showInformationMessage('Auto completion feature enabled, please try typing trigger characters in editor');
        } else if (langClient) {
            console.log('LSP server does not provide auto completion feature');
            vscode.window.showWarningMessage('LSP server does not provide auto completion feature, please check server implementation');
        }
    });

    // Add manual trigger auto completion command
    let completionDisposable = vscode.commands.registerCommand('Onion.triggerCompletion', async () => {        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'Onion') {
            vscode.window.showInformationMessage('Please use this command in an Onion file');
            return;
        }
        
        // Use custom method to directly send completion request to LSP
        await requestCompletionFromLSP(editor.document, editor.selection.active);
        console.log('Manually sent completion request to LSP server');
    });
      // Listen to text editing events to automatically trigger completion after user input
    const typingCompletionDisposable = vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document.languageId === 'Onion' && 
            event.contentChanges.length > 0 && 
            event.contentChanges[0].text.length > 0) {
            
            // Get current active editor
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document === event.document) {
                // Delay trigger to avoid frequent triggers
                setTimeout(() => {
                    // Use LSP request to get completion
                    requestCompletionFromLSP(event.document, editor.selection.active);
                }, 100);
            }
        }
    });

    // Listen to terminal close events to clear references
    vscode.window.onDidCloseTerminal(terminal => {
        if (OnionTerminal === terminal) {
            OnionTerminal = null;
        }
    });    // Add document change listener
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
            // Check if it's an Onion file
            if (event.document.languageId === 'Onion' && langClient) {
                console.log('Detected Onion file change, sending full update to LSP server');

                // Send complete document content instead of incremental changes
                langClient.sendNotification('textDocument/didChange', {
                    textDocument: {
                        uri: event.document.uri.toString(),
                        version: event.document.version
                    },
                    // Use single content change item containing complete document content
                    contentChanges: [
                        {
                            text: event.document.getText()
                        }
                    ]
                });
            }        })
    );
    // Add document save listener
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((document) => {
            if (document.languageId === 'Onion' && langClient) {
                console.log('Onion file saved, re-validating document');
                // Trigger document validation
                langClient.sendNotification('textDocument/didSave', {
                    textDocument: {
                        uri: document.uri.toString(),
                    },
                    text: document.getText()
                });
            }
        })
    );    // Add document open listener
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument((document) => {
            if (document.languageId === 'Onion' && langClient) {
                console.log('Onion file opened, notifying LSP server');
                langClient.sendNotification('textDocument/didOpen', {
                    textDocument: {
                        uri: document.uri.toString(),
                        languageId: document.languageId,
                        version: document.version,
                        text: document.getText()
                    },
                });
            }
        })
    );    // Add document close listener
    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument((document) => {
            if (document.languageId === 'Onion' && langClient) {
                console.log('Onion file closed, notifying LSP server');
                langClient.sendNotification('textDocument/didClose', {
                    textDocument: {
                        uri: document.uri.toString()
                    }
                });
            }
        })
    );

    context.subscriptions.push(disposable);
    context.subscriptions.push(testDisposable);
    context.subscriptions.push(completionDisposable);
    context.subscriptions.push(typingCompletionDisposable);

    const completionProvider = vscode.languages.registerCompletionItemProvider(
        [
            { scheme: 'file', language: 'Onion' },
            { scheme: 'untitled', language: 'Onion' },
            { scheme: 'file', pattern: '**/*.onion' }
        ],
        {            async provideCompletionItems(document, position, token, context) {
                // Use LSP request to get completion items and convert to VSCode completion items
                return requestCompletionFromLSP(document, position);
            }
        },
        // Trigger characters
        '.', ':', '(', ')', '[', ']', '{', '}', ',', ';',
        '+', '-', '*', '/', '%', '=', '!', '&', '|', '^', '~'
    );

    context.subscriptions.push(completionProvider);

}

/**
 * Start LSP server
 * @param {vscode.ExtensionContext} context 
 */
function startLSP(context) {
    // Get Onion executable file path
    const config = vscode.workspace.getConfiguration('Onion');
    let runtimePath = config.get('runtimePath') || 'onion';

    // Parse tilde symbol to user home directory
    if (runtimePath.startsWith('~')) {
        const homedir = require('os').homedir();
        runtimePath = path.join(homedir, runtimePath.substring(1));
    }    // Check if runtimePath is a directory, if so try to find executable file
    if (fs.existsSync(runtimePath) && fs.statSync(runtimePath).isDirectory()) {
        // Look for executable without extension on Linux/Mac, look for .exe file on Windows
        const exeName = process.platform === 'win32' ? 'onion.exe' : 'onion';
        const possiblePath = path.join(runtimePath, exeName);

        if (fs.existsSync(possiblePath)) {
            console.log(`Found executable file: ${possiblePath}`);
            runtimePath = possiblePath;
        } else {
            // If it's a directory but can't find executable, search target/release subdirectory
            const releasePath = path.join(runtimePath, 'target', 'release', exeName);
            if (fs.existsSync(releasePath)) {
                console.log(`Found executable file: ${releasePath}`);
                runtimePath = releasePath;
            }
        }
    }

    // Check if runtimePath exists
    const pathExists = fs.existsSync(runtimePath);
    if (!pathExists) {        if (path.isAbsolute(runtimePath)) {
            const message = `Onion executable file does not exist at path: ${runtimePath}. LSP functionality will not work properly.`;
            vscode.window.showErrorMessage(message);
            console.error(message);
            return; // Exit function if file doesn't exist
        } else {
            console.log(`Trying to use command from environment variables: ${runtimePath}`);
        }
    } else {
        console.log(`Using Onion executable file: ${runtimePath}`);
    }

    // Define initial TCP port, can be randomly generated or configured fixed port
    let initialPort = config.get('lspPort') || 9257; // Default port 9257, configurable

    // Automatically find available port
    findAvailablePort(initialPort)
        .then(availablePort => {
            console.log(`LSP will use port: ${availablePort}`);
            startActualLSP(context, runtimePath, availablePort);
        })        .catch(err => {
            const msg = `Unable to find available port: ${err.message}`;
            vscode.window.showErrorMessage(msg);
            console.error(msg);
        });
}

/**
 * Find available port
 * @param {number} startPort Starting port
 * @param {number} maxAttempts Maximum number of attempts
 * @returns {Promise<number>} Available port
 */
function findAvailablePort(startPort, maxAttempts = 10) {
    return new Promise((resolve, reject) => {
        let currentPort = startPort;
        let attempts = 0;

        function tryPort(port) {
            if (attempts >= maxAttempts) {
                reject(new Error(`Could not find available port after trying ${maxAttempts} ports`));
                return;
            }

            attempts++;
            const server = net.createServer();

            server.once('error', err => {
                if (err.code === 'EADDRINUSE') {
                    console.log(`Port ${port} is in use, trying next port...`);
                    tryPort(port + 1);
                } else {
                    reject(err);
                }
            });

            server.once('listening', () => {
                server.close(() => {
                    resolve(port);
                });
            });

            server.listen(port);
        }

        tryPort(currentPort);
    });
}
/**
 * Actually start LSP server
 */
function startActualLSP(context, runtimePath, lspPort) {
    console.log(`Starting LSP server: ${runtimePath} lsp --port ${lspPort}`);
    function checkExecutable() {
        return new Promise((resolve, reject) => {
            console.log(`Checking executable: ${runtimePath}`);
            const helpProcess = spawn(runtimePath, ['--help']);
            let stdoutData = '';
            let stderrData = '';

            helpProcess.stdout.on('data', (data) => {
                stdoutData += data.toString();
            });

            helpProcess.stderr.on('data', (data) => {
                stderrData += data.toString();
            });            helpProcess.on('error', (err) => {
                reject(new Error(`Executable validation failed: ${err.message}`));
            });

            helpProcess.on('exit', (code) => {
                if (code === 0) {
                    console.log('Executable validation successful');
                    resolve(true);
                } else {
                    reject(new Error(`Executable validation failed, exit code: ${code}, output: ${stdoutData}, error: ${stderrData}`));
                }
            });
        });
    }
    // Server options configuration - using TCP connection, adding retry logic
    const serverOptions = () => {
        return new Promise(async (resolve, reject) => {
            try {
                // First validate executable
                await checkExecutable();

                // Configure startup parameters, add debug flags
                const args = ['lsp', '--port', lspPort.toString()];
                console.log(`Startup command: ${runtimePath} ${args.join(' ')}`);

                // Start process
                const lspProcess = spawn(runtimePath, args);
                let started = false;
                let outputBuffer = '';
                let connectAttempts = 0;
                const maxConnectAttempts = 5;

                // Handle process standard output
                lspProcess.stdout.on('data', (data) => {
                    const message = data.toString();
                    outputBuffer += message;
                    console.log(`LSP server output: ${message.trim()}`);

                    // Check if there's startup success information
                    if (message.includes("LSP server started") ||
                        message.includes("server started") ||
                        message.includes("listening") ||
                        (!started && message.includes("port"))) {

                        console.log(`Detected LSP server startup info, preparing to connect to port: ${lspPort}`);
                        started = true;

                        // Define connection function with retry support
                        const attemptConnection = () => {
                            connectAttempts++;
                            console.log(`Attempting connection #${connectAttempts}...`);

                            try {
                                // Establish TCP socket connection
                                const socket = net.connect(lspPort);

                                socket.on('connect', () => {
                                    console.log(`Successfully connected to LSP server port: ${lspPort}`);
                                });

                                socket.on('error', (err) => {
                                    console.error(`Socket connection error #${connectAttempts}: ${err.message}`);
                                    if (connectAttempts < maxConnectAttempts) {
                                        console.log(`Retrying connection in 2 seconds...`);
                                        setTimeout(attemptConnection, 2000);
                                    } else {
                                        reject(new Error(`Connection failed after ${maxConnectAttempts} retries: ${err.message}`));
                                    }
                                });

                                // Return reader and writer
                                resolve({
                                    reader: socket,
                                    writer: socket
                                });
                            } catch (err) {
                                console.error(`Error creating connection #${connectAttempts}: ${err.message}`);
                                if (connectAttempts < maxConnectAttempts) {
                                    console.log(`Retrying connection in 2 seconds...`);
                                    setTimeout(attemptConnection, 2000);
                                } else {
                                    reject(new Error(`Connection failed after ${maxConnectAttempts} retries: ${err.message}`));
                                }
                            }
                        };

                        // Add delay time to ensure server fully starts
                        setTimeout(attemptConnection, 2000);
                    }
                });

                // Handle process error output
                lspProcess.stderr.on('data', (data) => {
                    const msg = data.toString();
                    console.log(`LSP server output: ${msg}`);

                    // In some cases, error output may also contain startup information
                    if (!started && (msg.includes("Listening") || msg.includes("port"))) {
                        started = true;
                        setTimeout(() => {
                            try {
                                const socket = net.connect(lspPort);
                                resolve({
                                    reader: socket,
                                    writer: socket
                                });
                            } catch (err) {
                                reject(err);
                            }
                        }, 2000);
                    }
                });

                // Handle process exit event
                lspProcess.on('exit', (code) => {
                    if (code !== 0 && !started) {
                        const message = `Onion LSP server process exited with status code ${code}`;
                        console.error(message);
                        reject(new Error(message));
                    } else if (started) {
                        console.log(`LSP server process exited, but connection has been established`);
                    }
                });

                // Handle process startup errors
                lspProcess.on('error', (err) => {
                    const message = `Unable to start Onion LSP server: ${err.message}`;
                    console.error(message);
                    reject(new Error(message));
                });

                // Timed check for successful connection
                setTimeout(() => {
                    if (!started) {
                        // Print all collected output on timeout to help debugging                        console.error('Timeout waiting for LSP server startup');
                        console.error('Collected output:', outputBuffer);
                        reject(new Error('Timeout waiting for LSP server startup'));
                    }
                }, 20000); // Increase timeout to 20 seconds

            } catch (err) {
                console.error('Pre-startup LSP server validation failed:', err.message);
                reject(err);
            }
        });
    };
    
    const clientOptions = {
        documentSelector: [
            { scheme: 'file', language: 'Onion' },
            { scheme: 'untitled', language: 'Onion' },
            { scheme: 'file', pattern: '**/*.onion' }, // Add file pattern matching
        ],
        synchronize: {
            configurationSection: 'Onion',
            fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{x,Onion}'), // Support multiple extensions
            // Add document content change synchronization support
            textDocumentSync: {
                openClose: true,
                change: 2, // Full document synchronization
                willSave: true,
                willSaveWaitUntil: true,
                save: {
                    includeText: true
                }
            }
        },
        // Enhanced auto-completion functionality
        middleware: {
            provideCompletionItem: (document, position, context, token, next) => {

            },
            // Add inline completion support
            provideInlineCompletionItems: async (document, position, context, token, next) => {
                // If the original middleware chain supports inline completion, continue
                if (next) {
                    return next(document, position, context, token);
                }
                return null;
            }
        },
        // Configuration feature support
        capabilities: {
            // Explicitly declare auto-completion support and reduce trigger restrictions
            completionProvider: {
                resolveProvider: true,
                triggerCharacters: [
                    '(', ')', '[', ']', '{', '}', '.', ',', ';', ':',
                    // Add more trigger characters
                    '+', '-', '*', '/', '%', '=', '!', '&', '|', '^', '~'
                ],
                allCommitCharacters: [' ', '\t', '\n', '(', ')', '[', ']', '{', '}', '.', ',', ';', ':']
            },
            // Support inline completion functionality
            inlineCompletionProvider: true,
            // Add semantic coloring support
            semanticTokensProvider: {
                full: true,
                range: false
            }
        },
        outputChannelName: 'Onion Language Server',
        revealOutputChannelOn: 1
    };
    try {
        // Create language client
        langClient = new LanguageClient('OnionLanguageServer', 'Onion Language Server', serverOptions, clientOptions);        // Before starting, first register semantic token types and modifiers
        // Define semantic token types (according to LSP specification)
        const tokenTypes = [
            'namespace', 'type', 'class', 'enum', 'interface',
            'struct', 'typeParameter', 'parameter', 'variable', 'property',
            'enumMember', 'event', 'function', 'method', 'macro',
            'keyword', 'modifier', 'comment', 'string', 'number',
            'regexp', 'operator', 'decorator',
            // Onion custom semantic token types
            'null', 'boolean', 'base64', 'let', 'body',
            'boundary', 'assign', 'lambdaDef', 'expressions', 'lambdaCall',
            'asyncLambdaCall', 'operation', 'tuple', 'assumeTuple', 'keyValue',
            'indexOf', 'getAttr', 'return', 'raise', 'if',
            'while', 'namedTo', 'break', 'continue', 'range',
            'in', 'emit', 'alias', 'set', 'map'
        ];
        
        // Define semantic token modifiers
        const tokenModifiers = [
            'declaration', 'definition', 'readonly', 'static',
            'deprecated', 'abstract', 'async', 'modification',
            'documentation', 'defaultLibrary'
        ];
        
  
        // Register semantic token information
        const legend = {
            tokenTypes,
            tokenModifiers
        };

        langClient.clientOptions.capabilities = langClient.clientOptions.capabilities || {};
        langClient.clientOptions.capabilities.textDocument = {
            ...(langClient.clientOptions.capabilities.textDocument || {}),
            semanticTokens: {
                dynamicRegistration: true,
                tokenTypes: tokenTypes,
                tokenModifiers: tokenModifiers,
                formats: ['relative'],
                requests: {
                    full: {
                        delta: false
                    },
                    range: false
                }
            }
        };
        
        // Add semantic token processing middleware
        langClient.clientOptions.middleware = {
            ...(langClient.clientOptions.middleware || {}),
            // Handle semantic token requests and responses
            workspace: {
                ...(langClient.clientOptions.middleware?.workspace || {}),                // Intercept and process semantic token responses
                handleWorkspaceSymbol: (params, token, next) => {
                    console.log('Intercepted workspace symbol request:', JSON.stringify(params));
                    return next(params, token);
                }
            },
            // Document operation middleware
            textDocument: {
                ...(langClient.clientOptions.middleware?.textDocument || {}),
                // Handle semantic token responses
                semanticTokens: {
                    ...(langClient.clientOptions.middleware?.textDocument?.semanticTokens || {}),
                    full: (document, token, next) => {
                        console.log(`Requesting semantic tokens for document: ${document.uri}`);
                        
                        // First check if server supports semantic tokens
                        if (!langClient.initializeResult?.capabilities?.semanticTokensProvider) {                            console.log('Server does not support semantic tokens functionality, skipping request');
                            // Return null to preserve existing coloring (if any)
                            return Promise.resolve(null);
                        }
                        
                        // Call original handler to get tokens
                        return next(document, token).then(tokens => {
                            if (tokens) {                                console.log(`Received semantic token data, data length: ${tokens.data ? tokens.data.length : 'unknown'}`);
                                if (tokens.data && tokens.data.length > 0) {
                                    console.log(`Token data example: [${tokens.data.slice(0, 10).join(', ')}]...`);
                                }
                            } else {                                console.log('No semantic token data received (server may have returned empty or null)');
                                // If server explicitly returns null or undefined, also preserve existing tokens
                            }
                            return tokens; // Return retrieved tokens
                        }).catch(error => {                            console.error(`Semantic token request failed: ${error.message}`);
                            // Return null on request failure, instructing VS Code to preserve previous tokens
                            return null;
                        });
                    }
                }
            }
        };
        
        // Register semantic token provider to server initialization options
        langClient.registerProposedFeatures();
        const initOptions = langClient.initializeParams?.initializationOptions || {};
        langClient.initializeParams = {
            ...langClient.initializeParams,
            initializationOptions: {
                ...initOptions,
                semanticTokens: {
                    legend: legend
                }
            }
        };

        // Start client
        const disposable = langClient.start();

        disposable.then(() => {            vscode.window.showInformationMessage('Onion language server started');
            console.log('LSP server started successfully');
        }).catch(error => {            vscode.window.showErrorMessage(`Onion language server startup failed: ${error.message}`);
            console.error('LSP startup failed:', error);
            langClient.outputChannel.show();
        });

        context.subscriptions.push({
            dispose: () => {
                if (langClient) {
                    langClient.stop();
                }
            }
        });

        // Add custom notification handler to get more log information
        langClient.onNotification('window/logMessage', (params) => {
            console.log(`LSP log: [${params.type}] ${params.message}`);
        });        // Add raw response data tracking
        langClient.onRequest('textDocument/completion', (params, token) => {
            console.log('Intercepted completion request:', JSON.stringify(params));
            // Don't handle request, return undefined to let regular processing continue
            return undefined;
        });

    } catch (err) {        console.error('Error creating LSP client:', err);
        vscode.window.showErrorMessage(`Unable to start Onion language service: ${err.message}`);
    }
}

/**
 * Convert Onion completion types to VSCode completion types
 * @param {string} kind Completion type name
 * @returns {number} VSCode completion type
 */
function translateCompletionKind(kind) {
    // Use VSCode built-in CompletionItemKind
    const vscodeKinds = vscode.CompletionItemKind;
    
    // Convert string type to VSCode CompletionItemKind
    if (typeof kind === 'string') {
        return kind in vscodeKinds ? vscodeKinds[kind] : vscodeKinds.Text;
    }
    
    // If already a number, check if within valid range
    if (typeof kind === 'number' && kind >= 1 && kind <= 25) {
        return kind;
    }
    
    // Default type
    return vscodeKinds.Text;
}

/**
 * Send completion request directly to LSP server
 * @param {vscode.TextDocument} document Current document
 * @param {vscode.Position} position Cursor position
 */
async function requestCompletionFromLSP(document, position) {
    if (!langClient) {
        console.log('LSP client not initialized, unable to request completion');
        return;
    }

    try {
        console.log(`Sending completion request to LSP, position: ${position.line}:${position.character}`);

        const params = {
            textDocument: {
                uri: document.uri.toString()
            },
            position: {
                line: position.line,
                character: position.character
            },
            context: {
                triggerKind: "Invoked"
            }
        };        // Log completion request parameters for debugging
        console.log('Sent completion request parameters:', JSON.stringify(params));

        // Send completion request to LSP server
        const completionList = await langClient.sendRequest('textDocument/completion', params);

        if (completionList) {
            const items = Array.isArray(completionList)
                ? completionList
                : (completionList.items || []);

            const itemCount = items.length;
            console.log(`Received completion suggestions from LSP: ${itemCount} items`);

            // Detailed logging of received suggestions for debugging
            if (itemCount > 0) {                console.log(`Completion suggestion examples: ${JSON.stringify(items.slice(0, 3))}`);

                // Convert LSP completion results to VSCode completion items
                const vscodeItems = items.map(item => {
                    return new vscode.CompletionItem(
                        item.label,
                        translateCompletionKind(item.kind)
                    );
                });                // Display completion items directly
                // Don't call triggerSuggest directly here, instead provide completion items through VSCode API
                return vscodeItems;
            }
        } else {
            console.log('LSP server did not return completion suggestions');
        }

        return []; // Return empty array indicating no completion suggestions

    } catch (error) {        console.error('Error getting completion request:', error);
        if (error.message) {
            console.error('Error message:', error.message);
        }
        if (error.code) {
            console.error('Error code:', error.code);
        }
        return []; // Return empty array on error
    }
}

/**
 * Run Onion file
 */
async function runOnionFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No open editor');
        return;
    }

    const document = editor.document;
    if (document.languageId !== 'Onion') {
        vscode.window.showErrorMessage('Current file is not an Onion file');
        return;
    }

    // Save file
    await document.save();
    const filePath = document.fileName;
    const fileDir = path.dirname(filePath);

    // Get user configuration
    const config = vscode.workspace.getConfiguration('Onion');
    let runtimePath = config.get('runtimePath') || 'onion';
    const useFullPath = config.get('useFullPath') || false;
    let workingDir = config.get('workingDirectory') || fileDir;
    const shellType = config.get('shellType') || 'default';    // If using full path but provided path is not absolute, try to find executable
    if (useFullPath && !path.isAbsolute(runtimePath)) {
        vscode.window.showWarningMessage('You have enabled using full path, but the provided path is not absolute');
    }

    // Determine Shell type
    const isWindows = process.platform === 'win32';
    let isPowerShell = false;

    // Set Shell type related parameters
    let terminalOptions = {
        name: 'Onion',
        cwd: workingDir
    };

    if (shellType !== 'default') {
        if (isWindows) {
            if (shellType === 'powershell') {
                terminalOptions.shellPath = 'powershell.exe';
                isPowerShell = true;
            } else if (shellType === 'cmd') {
                terminalOptions.shellPath = 'cmd.exe';
                terminalOptions.shellArgs = ['/C'];
            }
        } else {
            if (shellType === 'bash') {
                terminalOptions.shellPath = '/bin/bash';
            } else if (shellType === 'sh') {
                terminalOptions.shellPath = '/bin/sh';
            }
        }
    } else if (isWindows) {
        // Detect whether default terminal is PowerShell on Windows
        try {
            const defaultShell = vscode.env.shell;
            isPowerShell = defaultShell && defaultShell.toLowerCase().includes('powershell');
        } catch (error) {
            console.error('Unable to detect default Shell:', error);
        }
    }

    // Reuse or create terminal
    if (!OnionTerminal) {
        OnionTerminal = vscode.window.createTerminal(terminalOptions);
    }

    // Show terminal
    OnionTerminal.show();

    // Clear terminal (optional)
    // For PowerShell
    if (isPowerShell) {
        OnionTerminal.sendText('Clear-Host', true);
    }
    // For CMD and other terminals
    else if (isWindows) {
        OnionTerminal.sendText('cls', true);
    } else {
        OnionTerminal.sendText('clear', true);
    }

    // Build command - handle paths according to Shell type
    let command = '';

    // Process paths to ensure correct execution in different Shells
    if (isWindows) {
        if (isPowerShell) {
            // Execute in PowerShell
            if (runtimePath.includes(' ')) {
                command = `& '${runtimePath}' run '${filePath}'`;
            } else {
                command = `${runtimePath} run '${filePath}'`;
            }
        } else {
            // Execute in CMD
            command = `${runtimePath} run "${filePath}"`;
        }
    } else {
        // Unix-like systems
        if (runtimePath.includes(' ')) {
            command = `"${runtimePath}" run "${filePath}"`;
        } else {
            command = `${runtimePath} run "${filePath}"`;
        }
    }    // Send command to terminal
    console.log('Executing command:', command);
    OnionTerminal.sendText(command);    // If encountering problems, provide help information
    if (!fs.existsSync(runtimePath) && path.isAbsolute(runtimePath)) {
        OnionTerminal.sendText('', true);
        OnionTerminal.sendText('# Executable file path does not exist, please check Onion.runtimePath configuration', true);
    }
}

function deactivate() {
    // Clean up resources
    if (OnionTerminal) {
        OnionTerminal.dispose();
        OnionTerminal = null;
    }

    // Stop LSP client
    if (langClient) {
        return langClient.stop();
    }

    return undefined;
}

module.exports = {
    activate,
    deactivate
};