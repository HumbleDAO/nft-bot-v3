// ------------------------------------
// 1. DEPENDENCIES
// ------------------------------------

const dotenv = require("dotenv");

// Load base .env file first
dotenv.config();

// If there's a specific NODE_ENV set, attempt to load that environment specific .env file
if(process.env.NODE_ENV) {
	const environmentSpecificFile = `.env.${process.env.NODE_ENV}`;
	const fs = require("fs");

	if(fs.existsSync(environmentSpecificFile)) {
		dotenv.config({
			path: environmentSpecificFile,
			override: true
		});
	}
}

const Web3 = require("web3");
const WebSocket = require('ws');
const fetch = require('node-fetch');
const abis = require('./abis.js');
const { isForexCurrentlyOpen, startForexMonitoring } = require('./forex.js');
const { NonceManager } = require("./NonceManager.js");
const { NFTManager } = require("./NftManager.js");

// -----------------------------------------
// 2. GLOBAL VARIABLES
// -----------------------------------------

let allowedLink = false, currentlySelectedWeb3ClientIndex = -1, currentlySelectedWeb3Client = null, eventSubTrading = null, eventSubCallbacks = null,
	web3Clients = [], priorityTransactionMaxPriorityFeePerGas = 50, standardTransactionGasFees = { maxFee: 31, maxPriorityFee: 31 },
	knownOpenTrades = new Map(), spreadsP = [], openInterests = [], collaterals = [], triggeredOrders = new Map(),
	storageContract, tradingContract, callbacksContract, vaultContract, pairsStorageContract, nftRewardsContract,
	maxTradesPerPair = 0, linkContract;

// --------------------------------------------
// 3. INIT: CHECK ENV VARS & LINK ALLOWANCE
// --------------------------------------------

console.log("Welcome to the gTrade NFT bot!");
if(!process.env.WSS_URLS || !process.env.PRICES_URL || !process.env.STORAGE_ADDRESS
|| !process.env.PRIVATE_KEY || !process.env.PUBLIC_KEY || !process.env.EVENT_CONFIRMATIONS_SEC
|| !process.env.MAX_GAS_PRICE_GWEI || !process.env.CHECK_REFILL_SEC
|| !process.env.VAULT_REFILL_ENABLED || !process.env.AUTO_HARVEST_SEC || !process.env.MIN_PRIORITY_GWEI
|| !process.env.PRIORITY_GWEI_MULTIPLIER || !process.env.MAX_GAS_PER_TRANSACTION){
	console.log("Please fill all parameters in the .env file.");
	process.exit();
}

// Parse non-string configuration constants from environment variables up front
const MAX_GAS_PRICE_GWEI = parseInt(process.env.MAX_GAS_PRICE_GWEI, 10),
	  MAX_GAS_PER_TRANSACTION = parseInt(process.env.MAX_GAS_PER_TRANSACTION, 10),
	  CHECK_REFILL_SEC = parseInt(process.env.CHECK_REFILL_SEC, 10),
	  EVENT_CONFIRMATIONS_SEC = parseInt(process.env.EVENT_CONFIRMATIONS_SEC, 10),
	  AUTO_HARVEST_SEC = parseInt(process.env.AUTO_HARVEST_SEC, 10),
	  FAILED_ORDER_TRIGGER_TIMEOUT_MS = (process.env.FAILED_ORDER_TRIGGER_TIMEOUT_SEC ?? '').length > 0 ? parseFloat(process.env.FAILED_ORDER_TRIGGER_TIMEOUT_SEC) * 1000 : 60 * 1000;

const DRY_RUN_MODE = process.env.DRY_RUN_MODE === "true";

// Start monitoring forex
startForexMonitoring();

async function checkLinkAllowance() {
	try {
		const allowance = await linkContract.methods.allowance(process.env.PUBLIC_KEY, process.env.STORAGE_ADDRESS).call();

		if(parseFloat(allowance) > 0){
			allowedLink = true;
			console.log("LINK allowance OK.");
		}else{
			console.log("LINK not allowed, approving now.");

			const tx = {
				from: process.env.PUBLIC_KEY,
				to : linkContract.options.address,
				data : linkContract.methods.approve(process.env.STORAGE_ADDRESS, "115792089237316195423570985008687907853269984665640564039457584007913129639935").encodeABI(),
				maxPriorityFeePerGas: currentlySelectedWeb3Client.utils.toHex(standardTransactionGasFees.maxPriorityFee * 1e9),
				maxFeePerGas: currentlySelectedWeb3Client.utils.toHex(standardTransactionGasFees.maxFee * 1e9),
				gas: currentlySelectedWeb3Client.utils.toHex("100000"),
				nonce: nonceManager.getNextNonce()
			};

			try {
				const signed = await currentlySelectedWeb3Client.eth.accounts.signTransaction(tx, process.env.PRIVATE_KEY)

				await currentlySelectedWeb3Client.eth.sendSignedTransaction(signed.rawTransaction)

				console.log("LINK successfully approved.");
				allowedLink = true;
			} catch(error) {
				console.log("LINK approve tx fail (" + error + ")");

				throw error;
			}
		}
	} catch {
		setTimeout(() => { checkLinkAllowance(); }, 5*1000);
	}
}

// -----------------------------------------
// 4. WEB3 PROVIDER
// -----------------------------------------

const WEB3_PROVIDER_URLS = process.env.WSS_URLS.split(",");
let currentWeb3ClientBlocks = new Array(WEB3_PROVIDER_URLS.length).fill(0);

async function setCurrentWeb3Client(newWeb3ClientIndex){
	console.log("Switching web3 client to " + WEB3_PROVIDER_URLS[newWeb3ClientIndex] + " (#" + newWeb3ClientIndex + ")...");

	const executionStartTime = Date.now();
	const newWeb3Client = web3Clients[newWeb3ClientIndex];

	// Unsubscribe from existing events first
	if(eventSubTrading !== null && eventSubTrading.id !== null){ eventSubTrading.unsubscribe(); }
	if(eventSubCallbacks !== null && eventSubCallbacks.id !== null){ eventSubCallbacks.unsubscribe(); }
	eventSubTrading = null;
	eventSubCallbacks = null;

	storageContract = new newWeb3Client.eth.Contract(abis.STORAGE, process.env.STORAGE_ADDRESS);

	// Retrieve all necessary details from the storage contract
	const [
		aggregatorAddress,
		callbacksAddress,
		tradingAddress,
		vaultAddress,
		linkAddress
	] = await Promise.all([
		storageContract.methods.priceAggregator().call(),
		storageContract.methods.callbacks().call(),
		storageContract.methods.trading().call(),
		storageContract.methods.vault().call(),
		storageContract.methods.linkErc677().call()
	]);

	const aggregatorContract = new newWeb3Client.eth.Contract(abis.AGGREGATOR, aggregatorAddress);

	// Retrieve all necessary details from the aggregator contract
	const [
		pairsStorageAddress,
		nftRewardsAddress
	 ] = await Promise.all([
		aggregatorContract.methods.pairsStorage().call(),
		aggregatorContract.methods.nftRewards().call()
	 ]);

	pairsStorageContract = new newWeb3Client.eth.Contract(abis.PAIRS_STORAGE, pairsStorageAddress);
	nftRewardsContract = new newWeb3Client.eth.Contract(abis.NFT_REWARDS, nftRewardsAddress);

	callbacksContract = new newWeb3Client.eth.Contract(abis.CALLBACKS, callbacksAddress);
	tradingContract = new newWeb3Client.eth.Contract(abis.TRADING, tradingAddress);
	vaultContract = new newWeb3Client.eth.Contract(abis.VAULT, vaultAddress);


	linkContract = new newWeb3Client.eth.Contract(abis.LINK, linkAddress);

	// Update the globally selected provider with this new provider
	currentlySelectedWeb3ClientIndex = newWeb3ClientIndex;
	currentlySelectedWeb3Client = newWeb3Client;

	// Subscribe to events using the new provider
	watchLiveTradingEvents();

	// Fire and forget refreshing of data using new provider
	fetchTradingVariables();
	fetchOpenTrades();
	checkLinkAllowance();

	console.log("New web3 client selection completed. Took: " + (Date.now() - executionStartTime) + "ms");
}

function createWeb3Provider(providerUrl) {
	const provider = new Web3.providers.WebsocketProvider(
		providerUrl,
		{
			clientConfig: {
				keepalive:true,
				keepaliveInterval:30*1000,
			 },
			 reconnect: {
				auto: true,
				delay: 1000,
				onTimeout: true
			}
		});

	provider.on('connect', () => {
		if(provider.connected){
			console.log(`Connected to provider ${providerUrl}`);
		}
	});

	provider.on('reconnect', () => {
		console.log(`Reconnecting to provider ${providerUrl}...`);
	})

	provider.on('error', (error) => {
		console.log(`Provider error: ${providerUrl}`, error);
	});

	return provider;
};

function createWeb3Client(providerUrl, nonceManager ) {
	const provider = createWeb3Provider(providerUrl);
	const web3Client = new Web3(provider);

	const connectHandler = async() => {
		if(!nonceManager.isInitialized) {
			nonceManager.initializeFromClient(web3Client);
		}

		provider.off("connect", connectHandler)
	}

	provider.on("connect", connectHandler);

	return web3Client;
}

const nonceManager = new NonceManager(process.env.PUBLIC_KEY);
const nftManager = new NFTManager(process.env.STORAGE_ADDRESS);

for(var web3ProviderUrlIndex = 0; web3ProviderUrlIndex < WEB3_PROVIDER_URLS.length; web3ProviderUrlIndex++){
	web3Clients.push(createWeb3Client(WEB3_PROVIDER_URLS[web3ProviderUrlIndex], nonceManager));
}

const MAX_PROVIDER_BLOCK_DRIFT = 2;

async function checkWeb3ClientLiveness() {
	console.log("Checking liveness of all " + WEB3_PROVIDER_URLS.length + " web3 client(s)...");

	const executionStartTime = Date.now();

	try {
		const latestWeb3ProviderBlocks = await Promise.all(WEB3_PROVIDER_URLS.map(async (providerUrl, providerIndex) => {
			// If not currently connected, then skip call
			if(web3Clients[providerIndex].connected === false) {
				return Number.MAX_SAFE_INTEGER;
			}

			try
			{
				return await web3Clients[providerIndex].eth.getBlockNumber();
			} catch (error) {
				console.log("Error retrieving current block number from web3 client " + providerUrl + ": " + error.message, error);

				return Number.MIN_SAFE_INTEGER;
			}
		}));

		console.log("Current vs. latest provider blocks: ", WEB3_PROVIDER_URLS, currentWeb3ClientBlocks, latestWeb3ProviderBlocks);

		// Update global to latest blocks
		currentWeb3ClientBlocks = latestWeb3ProviderBlocks;

		const originalWeb3ClientIndex = currentlySelectedWeb3ClientIndex;

		// Check if no client has been selected yet (i.e. this is initialization phase of app)
		if(originalWeb3ClientIndex === -1){
			await selectInitialProvider();
		} else {
			await ensureCurrentlySelectedProviderHasLatestBlock(originalWeb3ClientIndex);
		}

		console.log("Web3 client liveness check completed. Took: " + (Date.now() - executionStartTime) + "ms");
	} catch (error) {
		console.log("An unexpected error occurred while checking web3 client liveness!!!", error);
	} finally {
		// Schedule the next check
		setTimeout(async () => {
			checkWeb3ClientLiveness();
		}, 10*1000);
	}

	async function selectInitialProvider() {
		// Find the most recent block
		const maxBlock = Math.max(...currentWeb3ClientBlocks);

		const clientWithMaxBlockIndex = currentWeb3ClientBlocks.findIndex(v => v === maxBlock);

		// Start with the provider with the most recent block
		await setCurrentWeb3Client(clientWithMaxBlockIndex);

		console.log("Initial Web3 client selected: " + WEB3_PROVIDER_URLS[clientWithMaxBlockIndex]);
	}

	async function ensureCurrentlySelectedProviderHasLatestBlock(originalWeb3ClientIndex) {
		const currentlySelectedWeb3ClientIndexMaxDriftBlock = currentWeb3ClientBlocks[currentlySelectedWeb3ClientIndex] + MAX_PROVIDER_BLOCK_DRIFT;

		for(let i = 0; i < currentWeb3ClientBlocks.length; i++){
			// Don't check the currently selected client against itself
			if(i === currentlySelectedWeb3ClientIndex) {
				continue;
			}

			// If the current provider is ahead of the selected provider by more N blocks then switch to this provider instead
			if(currentWeb3ClientBlocks[i] >= currentlySelectedWeb3ClientIndexMaxDriftBlock){
				console.log("Switching to provider " + WEB3_PROVIDER_URLS[i] + " #" + i + " (" + currentWeb3ClientBlocks[i] + " vs " + currentWeb3ClientBlocks[currentlySelectedWeb3ClientIndex] + ")");

				await setCurrentWeb3Client(i);

				break;
			}
		}

		if(currentlySelectedWeb3ClientIndex === originalWeb3ClientIndex) {
			console.log("No need to switch to a different client; sticking with " + WEB3_PROVIDER_URLS[currentlySelectedWeb3ClientIndex] + ".");
		} else {
			console.log("Switched to client " + WEB3_PROVIDER_URLS[currentlySelectedWeb3ClientIndex] + " completed.");
		}
	}
}

checkWeb3ClientLiveness();

setInterval(() => {
	console.log("Current Web3 client: " + currentlySelectedWeb3Client.currentProvider.url + " (#"+currentlySelectedWeb3ClientIndex+")");
}, 120*1000);

// -----------------------------------------
// 5. FETCH DYNAMIC GAS PRICE
// -----------------------------------------

setInterval(() => {
	fetch("https://gasstation-mainnet.matic.network/v2/").then(r => r.json()).then((r) => {
		standardTransactionGasFees = { maxFee: Math.round(r.standard.maxFee), maxPriorityFee: Math.round(r.standard.maxPriorityFee) };

		priorityTransactionMaxPriorityFeePerGas = Math.round(
			Math.max(
				Math.round(r.fast.maxPriorityFee) * process.env.PRIORITY_GWEI_MULTIPLIER,
				process.env.MIN_PRIORITY_GWEI
			)
		);
	}).catch(() => { console.log("Error while fetching fastest gwei from gas station.") });
}, 3*1000);

// -----------------------------------------
// 6. FETCH PAIRS, NFTS, AND NFT TIMELOCK
// -----------------------------------------

async function fetchTradingVariables(){
	const executionStartTime = new Date().getTime();

	try
	{
		await Promise.all(
			[
				nftManager.loadNfts(currentlySelectedWeb3Client),
				fetchPairs()
			]);

		const executionEndTime = new Date().getTime();

		console.log("Done fetching trading variables. Took: " + (executionEndTime - executionStartTime) + "ms");
	} catch(error) {
		console.log("Error while fetching trading variables: " + error.message, error);

		setTimeout(() => { fetchTradingVariables(); }, 2*1000);
	};

	async function fetchPairs() {
		const [
			maxPerPair,
			pairsCount
		] = await Promise.all(
			[
				storageContract.methods.maxTradesPerPair().call(),
				pairsStorageContract.methods.pairsCount().call()
			]);

		let pairsPromises = [];
		for(var i = 0; i < pairsCount; i++){
			pairsPromises.push(pairsStorageContract.methods.pairsBackend(i).call());
		}

		const pairs = await Promise.all(pairsPromises);
		const newSpreadsP = new Array(pairs.length);
		const newOpenInterests = new Array(pairs.length);
		const newCollaterals = new Array(pairs.length);

		await Promise.all(pairs.map(async (pair, pairIndex) => {
			const [
				openInterestLong,
				openInterestShort,
				openInterestMax,
				collateralLong,
				collateralShort,
				collateralMax
				] = await Promise.all(
					[
					storageContract.methods.openInterestDai(pairIndex, 0).call(),
					storageContract.methods.openInterestDai(pairIndex, 1).call(),
					storageContract.methods.openInterestDai(pairIndex, 2).call(),
					pairsStorageContract.methods.groupsCollaterals(pairIndex, 0).call(),
					pairsStorageContract.methods.groupsCollaterals(pairIndex, 1).call(),
					pairsStorageContract.methods.groupMaxCollateral(pairIndex).call()
				]);

			newOpenInterests[pairIndex] = {long: openInterestLong, short: openInterestShort, max: openInterestMax};
			newCollaterals[pairIndex] = {long: collateralLong, short: collateralShort, max: collateralMax};
			newSpreadsP[pairIndex] = pair["0"].spreadP;
		}));

		maxTradesPerPair = maxPerPair;
		spreadsP = newSpreadsP;
		openInterests = newOpenInterests;
		collaterals = newCollaterals;
	}
}

// Force refresh every 60 seconds (for now)
setInterval(() => {
	fetchTradingVariables();
	fetchOpenTrades();
}, 60*1000);


// -----------------------------------------
// 8. LOAD OPEN TRADES
// -----------------------------------------

function buildOpenTradeKey({ trader, pairIndex, index }) {
	return `t=${trader};pi=${pairIndex};i=${index};`;
}

function buildTriggeredOrderTrackingInfoIdentifier({ trader, pairIndex, index, orderType }) {
	return `t=${trader};pi=${pairIndex};i=${index};ot=${orderType};`;
}

let fetchOpenTradesRetryTimerId = null;

async function fetchOpenTrades(){
	console.log("Fetching open trades...");

	try {
		if(spreadsP.length === 0){
			console.log("WARNING: Spreads are not yet loaded; will retry fetching open trades shortly!");

			scheduleRetryFetchOpenTrades();

			return;
		}

		const [
			openLimitOrders,
			pairTraders
		] = await Promise.all(
			[
				fetchOpenLimitOrders(),
				fetchOpenPairTrades()
			]);

		knownOpenTrades = new Map(openLimitOrders.concat(pairTraders).map(trade => [buildOpenTradeKey({ trader: trade.trader, pairIndex: trade.pairIndex, index: trade.index }), trade]));

		console.log("Fetched " + knownOpenTrades.size + " total open trade(s).");
	} catch(error) {
		console.log("Error fetching open trades: " + error.message, error);

		scheduleRetryFetchOpenTrades();
	}

	function scheduleRetryFetchOpenTrades() {
		if(fetchOpenTradesRetryTimerId !== null) {
			console.log("Already scheduled retry fetching open trades; will retry shortly!");

			return;
		}

		fetchOpenTradesRetryTimerId = setTimeout(() => { fetchOpenTrades(); fetchOpenTradesRetryTimerId = null; }, 2*1000);
	}

	async function fetchOpenLimitOrders() {
		console.log("Fetching open limit orders...");

		const openLimitOrders = await storageContract.methods.getOpenLimitOrders().call();

		const openLimitOrdersWithTypes = await Promise.all(openLimitOrders.map(async olo => {
			const type = await nftRewardsContract.methods.openLimitOrderTypes(olo.trader, olo.pairIndex, olo.index).call();

			return { ...olo, type };
		}));

		console.log("Fetched " + openLimitOrdersWithTypes.length + " open limit order(s).");

		return openLimitOrdersWithTypes;
	}

	async function fetchOpenPairTrades() {
		console.log("Fetching open pair trades...");

		const allOpenPairTrades = (await Promise.all(spreadsP.map(async (_, spreadPIndex) => {
			const pairTraderAddresses = await storageContract.methods.pairTradersArray(spreadPIndex).call();

			const openTradesForPairTraders = await Promise.all(pairTraderAddresses.map(async pairTraderAddress => {
				const openTradesCalls = new Array(maxTradesPerPair);

				for(let pairTradeIndex = 0; pairTradeIndex < maxTradesPerPair; pairTradeIndex++){
					openTradesCalls[pairTradeIndex] = storageContract.methods.openTrades(pairTraderAddress, spreadPIndex, pairTradeIndex).call();
				}

				const openTradesForTraderAddress = await Promise.all(openTradesCalls);

				// Filter out any of the trades that aren't *really* open (NOTE: these will have an empty trader address, so just test against that)
				return openTradesForTraderAddress.filter(openTrade => openTrade.trader === pairTraderAddress);
			}));

			return openTradesForPairTraders;
		}))).flat(2);

		console.log("Fetched " + allOpenPairTrades.length + " open pair trade(s).");

		return allOpenPairTrades;
	}
}
// -----------------------------------------
// 9. WATCH TRADING EVENTS
// -----------------------------------------

function watchLiveTradingEvents(){
	try {
		if(eventSubTrading === null){
			eventSubTrading = tradingContract.events.allEvents({ fromBlock: 'latest' }).on('data', function (event){
				const eventName = event.event;

				if(eventName !== "OpenLimitPlaced" && eventName !== "OpenLimitUpdated"
				&& eventName !== "OpenLimitCanceled" && eventName !== "TpUpdated"
				&& eventName !== "SlUpdated"){
					return;
				}

				event.triedTimes = 1;

				setTimeout(() => {
					refreshOpenTrades(event);
				}, EVENT_CONFIRMATIONS_SEC*1000);
			});
		}

		if(eventSubCallbacks === null){
			eventSubCallbacks = callbacksContract.events.allEvents({ fromBlock: 'latest' }).on('data', function (event){
				const eventName = event.event;

				if(eventName !== "MarketExecuted" && eventName !== "LimitExecuted"
				&& eventName !== "MarketCloseCanceled" && eventName !== "SlUpdated"
				&& eventName !== "SlCanceled"){
					return;
				}

				event.triedTimes = 1;

				setTimeout(() => {
					refreshOpenTrades(event);
				}, EVENT_CONFIRMATIONS_SEC*1000);
			});
		}
	} catch {
		setTimeout(() => { watchLiveTradingEvents(); }, 2*1000);
	}
}

// -----------------------------------------
// 10. REFRESH INTERNAL OPEN TRADES LIST
// -----------------------------------------
const MAX_EVENT_RETRY_TIMES = 10;

async function refreshOpenTrades(event){
	try {
		const eventName = event.event;
		const eventValues = event.returnValues;
		let failed = false;

		// UNREGISTER OPEN LIMIT ORDER
		// => IF OPEN LIMIT CANCELED OR OPEN LIMIT EXECUTED
		if(eventName === "OpenLimitCanceled"
				||
			(eventName === "LimitExecuted" && eventValues.orderType.toString() === "3")) {
			const trader = eventName === "OpenLimitCanceled" ? eventValues.trader : eventValues.t[0];
			const pairIndex = eventName === "OpenLimitCanceled" ? eventValues.pairIndex : eventValues.t[1];
			const index = eventName === "OpenLimitCanceled" ? eventValues.index : eventValues.limitIndex;

			const hasLimitOrder = await storageContract.methods.hasOpenLimitOrder(trader, pairIndex, index).call();

			if(hasLimitOrder.toString() === "false") {
				const tradeKey = buildOpenTradeKey({ trader, pairIndex, index });
				const existingKnownOpenTrade = knownOpenTrades.get(tradeKey);

				if(existingKnownOpenTrade !== undefined && existingKnownOpenTrade.hasOwnProperty('minPrice')) {
					knownOpenTrades.delete(tradeKey);

					console.log("Watch events ("+eventName+"): Removed limit");
				}
			}else{
				failed = true;
			}
		}

		// STORE/UPDATE OPEN LIMIT ORDER
		// => IF OPEN LIMIT ORDER PLACED OR OPEN LIMIT ORDER UPDATED
		if(eventName === "OpenLimitPlaced"
				||
			eventName === "OpenLimitUpdated"){
			const { trader, pairIndex, index } = eventValues;
			const hasLimitOrder = await storageContract.methods.hasOpenLimitOrder(trader, pairIndex, index).call();

			if(hasLimitOrder.toString() === "true") {
				const id = await storageContract.methods.openLimitOrderIds(trader, pairIndex, index).call();

				const [
					limitOrder,
					type
				] = await Promise.all(
					[
						storageContract.methods.openLimitOrders(id).call(),
						nftRewardsContract.methods.openLimitOrderTypes(trader, pairIndex, index).call()
					]);

				limitOrder.type = type;

				const tradeKey = buildOpenTradeKey({ trader, pairIndex, index });
				const existingKnownOpenTrade = knownOpenTrades.get(tradeKey);

				if(existingKnownOpenTrade !== undefined && existingKnownOpenTrade.hasOwnProperty('minPrice')){
					knownOpenTrades.set(tradeKey, limitOrder);

					console.log("Watch events ("+eventName+"): Updated limit");
				} else {
					knownOpenTrades.set(tradeKey, limitOrder);

					console.log("Watch events ("+eventName+"): Stored limit");
				}
			} else {
				failed = true;
			}
		}

		// STORE/UPDATE TRADE
		// => IF MARKET OPEN EXECUTED OR OPEN TRADE LIMIT EXECUTED OR TP/SL UPDATED OR TRADE UPDATED (MARKET CLOSED)
		if((eventName === "MarketExecuted" && eventValues.open === true)
				||
			(eventName === "LimitExecuted" && eventValues.orderType.toString() === "3")
				||
			eventName === "TpUpdated" || eventName === "SlUpdated" || eventName === "SlCanceled"
				||
			eventName === "MarketCloseCanceled"){
			const trader = eventName !== "MarketExecuted" && eventName !== "LimitExecuted" ? eventValues.trader : eventValues.t[0];
			const pairIndex = eventName !== "MarketExecuted" && eventName !== "LimitExecuted" ? eventValues.pairIndex : eventValues.t[1];
			const index = eventName !== "MarketExecuted" && eventName !== "LimitExecuted" ? eventValues.index : eventValues.t[2];

			const trade = await storageContract.methods.openTrades(trader, pairIndex, index).call();

			// Make sure the trade is still open
			if(parseFloat(trade.leverage) > 0) {
				const tradeKey = buildOpenTradeKey({ trader, pairIndex, index });
				const existingKnownOpenTrade = knownOpenTrades.get(tradeKey);

				if(existingKnownOpenTrade !== undefined && existingKnownOpenTrade.hasOwnProperty('openPrice')) {
					knownOpenTrades.set(tradeKey, trade);

					console.log("Watch events ("+eventName+"): Updated trade");
				} else {
					knownOpenTrades.set(tradeKey, trade);

					console.log("Watch events ("+eventName+"): Stored trade");
				}
			} else {
				failed = true;
			}
		}

		// UNREGISTER TRADE
		// => IF MARKET CLOSE EXECUTED OR CLOSE LIMIT EXECUTED
		if((eventName === "MarketExecuted" && eventValues.open.toString() === "false")
				||
			(eventName === "LimitExecuted" && eventValues.orderType !== "3")){
			const [ trader, pairIndex, index ] = eventValues.t;
			const trade = await storageContract.methods.openTrades(trader, pairIndex, index).call();

			if(parseFloat(trade.leverage) === 0){
				const triggeredOrderTrackingInfoIdentifier = buildTriggeredOrderTrackingInfoIdentifier({
					trader,
					pairIndex,
					index,
					orderType: eventValues.orderType
				});

				const triggeredOrderDetails = triggeredOrders.get(triggeredOrderTrackingInfoIdentifier);

				// If we were tracking this triggered order, stop tracking it now and clear the timeout so it doesn't
				// interrupt the event loop for no reason later
				if(triggeredOrderDetails !== undefined) {
					clearTimeout(triggeredOrderDetails.cleanupTimerId);

					triggeredOrders.delete(triggeredOrderTrackingInfoIdentifier);
				}

				const tradeKey = buildOpenTradeKey({ trader, pairIndex, index });
				const existingKnownOpenTrade = knownOpenTrades.get(tradeKey);

				if(existingKnownOpenTrade !== undefined && existingKnownOpenTrade.hasOwnProperty('openPrice')) {
					knownOpenTrades.delete(tradeKey);

					console.log("Watch events (" + eventName + "): Removed trade");
				}
			} else {
				failed = true;
			}
		}

		if(failed) {
			if(event.triedTimes == MAX_EVENT_RETRY_TIMES) {
				console.log("WARNING: Failed to process event '" + eventName + "' (from block #" + event.blockNumber + ") the max number of times (" + MAX_EVENT_RETRY_TIMES + "). This event will be dropped and not tried again.", event);

				return;
			}

			event.triedTimes++;

			setTimeout(() => {
				refreshOpenTrades(event);
			}, EVENT_CONFIRMATIONS_SEC/2*1000);

			console.log("Watch events ("+eventName+"): Trade not found on the blockchain, trying again in " + (EVENT_CONFIRMATIONS_SEC/2) + " seconds.");
		}
	} catch(error) {
		console.log("Problem when refreshing trades: " + error.message, error);
	}
}


// ---------------------------------------------
// 11. FETCH CURRENT PRICES & TRIGGER ORDERS
// ---------------------------------------------


function wss() {
	let socket = new WebSocket(process.env.PRICES_URL);
	socket.onclose = () => { setTimeout(() => { wss() }, 2000); };
	socket.onerror = () => { socket.close(); };
	socket.onmessage = async (msg) => {
		if(spreadsP.length === 0) {
			console.log("WARNING: Spreads are not yet loaded; unable to process any trades!");

			return;
		}

		if(!allowedLink) {
			console.log("WARNING: link is not currently allowed; unable to process any trades!");

			return;
		}

		const messageData = JSON.parse(msg.data);

		if(messageData.closes === undefined) {
			console.log('No closes in this message; ignoring.')

			return;
		}

		const forexMarketClosed = !isForexCurrentlyOpen();
		let skippedForexTradeCount = 0;

		for(const openTrade of knownOpenTrades.values()) {
			const { pairIndex } = openTrade;

			if(forexMarketClosed && pairIndex >= 21 && pairIndex <= 30) {
				skippedForexTradeCount++;

				continue;
			}

			const price = messageData.closes[pairIndex];
			const buy = openTrade.buy;
			let orderType = -1;

			if(openTrade.openPrice !== undefined) {
				const tp = parseFloat(openTrade.tp)/1e10;
				const sl = parseFloat(openTrade.sl)/1e10;
				const open = parseFloat(openTrade.openPrice)/1e10;
				const lev = parseFloat(openTrade.leverage);
				const liqPrice = buy ? open - 0.9/lev*open : open + 0.9/lev*open;

				if(tp !== 0 && ((buy && price >= tp) || (!buy && price <= tp))) {
					orderType = 0;
				} else if(sl !== 0 && ((buy && price <= sl) || (!buy && price >= sl))) {
					orderType = 1;
				} else if(sl === 0 && ((buy && price <= liqPrice) || (!buy && price >= liqPrice))) {
					orderType = 2;
				}
			} else {
				const spread = spreadsP[pairIndex]/1e10*(100-openTrade.spreadReductionP)/100;
				const priceIncludingSpread = !buy ? price*(1-spread/100) : price*(1+spread/100);
				const interestDai = buy ? parseFloat(openInterests[pairIndex].long) : parseFloat(openInterests[pairIndex].short);
				const collateralDai = buy ? parseFloat(collaterals[pairIndex].long) : parseFloat(collaterals[pairIndex].short);
				const newInterestDai = (interestDai + parseFloat(openTrade.leverage)*parseFloat(openTrade.positionSize));
				const newCollateralDai = (collateralDai + parseFloat(openTrade.positionSize));
				const maxInterestDai = parseFloat(openInterests[pairIndex].max);
				const maxCollateralDai = parseFloat(collaterals[pairIndex].max);
				const minPrice = parseFloat(openTrade.minPrice)/1e10;
				const maxPrice = parseFloat(openTrade.maxPrice)/1e10;

				if(newInterestDai <= maxInterestDai && newCollateralDai <= maxCollateralDai) {
					const tradeType = openTrade.type;

					if(tradeType === "0" && priceIncludingSpread >= minPrice && priceIncludingSpread <= maxPrice
					|| tradeType === "1" && (buy ? priceIncludingSpread <= maxPrice : priceIncludingSpread >= minPrice)
					|| tradeType === "2" && (buy ? priceIncludingSpread >= minPrice : priceIncludingSpread <= maxPrice)){
						orderType = 3;
					}
				}
			}

			if(orderType > -1) {
				// Attempt to lease an available NFT to process this order
				const availableNft = await nftManager.leaseAvailableNft(currentlySelectedWeb3Client);

				// If there are no more NFTs available, we can stop trying to trigger any other trades
				if(availableNft === null) {
					console.log("No NFTS available; unable to trigger any other trades at this time!");

					return;
				}

				const { trader, index } = openTrade;
					const triggeredOrderTrackingInfoIdentifier = buildTriggeredOrderTrackingInfoIdentifier({
						trader,
						pairIndex,
						index,
						orderType
					});

				const triggeredOrderDetails = {
					cleanupTimerId: null,
				};

				// Make sure this order hasn't already been triggered
				if(triggeredOrders.has(triggeredOrderTrackingInfoIdentifier)) {
					console.log("Order has already been triggered; skipping.");

					continue;
				}

				// Track that we're triggering this order
				triggeredOrders.set(triggeredOrderTrackingInfoIdentifier, triggeredOrderDetails);

				console.log("Trying to trigger " + triggeredOrderTrackingInfoIdentifier + " order with nft: " + availableNft.id + ")");

				try {
					const tx = {
						from: process.env.PUBLIC_KEY,
						to: tradingContract.options.address,
						data : tradingContract.methods.executeNftOrder(orderType, trader, pairIndex, index, availableNft.id, availableNft.type).encodeABI(),
						maxPriorityFeePerGas: currentlySelectedWeb3Client.utils.toHex(priorityTransactionMaxPriorityFeePerGas*1e9),
						maxFeePerGas: currentlySelectedWeb3Client.utils.toHex(MAX_GAS_PRICE_GWEI*1e9),
						gas: MAX_GAS_PER_TRANSACTION,
						nonce: nonceManager.getNextNonce(),
					};

					const signedTransaction = await currentlySelectedWeb3Client.eth.accounts.signTransaction(tx, process.env.PRIVATE_KEY);

					triggeredOrderDetails.cleanupTimerId = setTimeout(() => {
						if(triggeredOrders.delete(triggeredOrderTrackingInfoIdentifier)) {
							console.log(`Never heard back from the blockchain about triggered order ${triggeredOrderTrackingInfoIdentifier}; removed from tracking.`);
						}
					}, FAILED_ORDER_TRIGGER_TIMEOUT_MS * 10);

					await currentlySelectedWeb3Client.eth.sendSignedTransaction(signedTransaction.rawTransaction)

					console.log(`Triggered order for ${triggeredOrderTrackingInfoIdentifier} with NFT ${availableNft.id}.`);
				} catch(error) {
					console.log(`An unexpected error occurred trying to trigger an order for ${triggeredOrderTrackingInfoIdentifier} with NFT ${availableNft.id}.`, error);

					// TODO: add checking of reverted reason and handle each case more specifically
					//const tradeKey = buildOpenTradeKey({ trader, pairIndex, index });

					//if(error.message.includes("NO_TRADE")) {
						// The trade is gone, just remove it from known trades
					//	knownOpenTrades.delete(tradeKey);
					//	triggeredOrders.delete(triggeredOrderTrackingInfoIdentifier);
					//} else {
						// Wait a bit and then clean from triggered orders list so it might get tried again
						triggeredOrderDetails.cleanupTimerId = setTimeout(() => {
							if(!triggeredOrders.delete(triggeredOrderTrackingInfoIdentifier)) {
								console.log(`Tried to clean up triggered order ${triggeredOrderTrackingInfoIdentifier} which previously failed, but it was already removed?`);
							}

						}, FAILED_ORDER_TRIGGER_TIMEOUT_MS);
					//}
				} finally {
					// Always release the NFT back to the NFT manager
					nftManager.releaseNft(availableNft);
				}
			}
		}

		if(skippedForexTradeCount > 0) {
			// console.log(`${skippedForexTradeCount} trades were forex trades, but the forex market is currently closed so they were skipped.`);
		}
	}
}

wss();

// ------------------------------------------
// 12. REFILL VAULT IF CAN BE REFILLED
// ------------------------------------------

if(process.env.VAULT_REFILL_ENABLED === "true") {
	async function refill(){
		const tx = {
			from: process.env.PUBLIC_KEY,
			to : vaultContract.options.address,
			data : vaultContract.methods.refill().encodeABI(),
			maxPriorityFeePerGas: currentlySelectedWeb3Client.utils.toHex(standardTransactionGasFees.maxPriorityFee*1e9),
			maxFeePerGas: currentlySelectedWeb3Client.utils.toHex(standardTransactionGasFees.maxFee*1e9),
			gas: MAX_GAS_PER_TRANSACTION,
			nonce: nonceManager.getNextNonce()
		};

		try{
			const signed = await currentlySelectedWeb3Client.eth.accounts.signTransaction(tx, process.env.PRIVATE_KEY)

			await currentlySelectedWeb3Client.eth.sendSignedTransaction(signed.rawTransaction);

			console.log("Vault successfully refilled.");
		} catch(error) {
			console.log("Vault refill tx fail", error);
		};
	}

	async function deplete(){
		const tx = {
			from: process.env.PUBLIC_KEY,
			to : vaultContract.options.address,
			data : vaultContract.methods.deplete().encodeABI(),
			maxPriorityFeePerGas: currentlySelectedWeb3Client.utils.toHex(standardTransactionGasFees.maxPriorityFee*1e9),
			maxFeePerGas: currentlySelectedWeb3Client.utils.toHex(standardTransactionGasFees.maxFee*1e9),
			gas: MAX_GAS_PER_TRANSACTION,
			nonce: nonceManager.getNextNonce()
		};

		try {
			const signed = await currentlySelectedWeb3Client.eth.accounts.signTransaction(tx, process.env.PRIVATE_KEY);

			await currentlySelectedWeb3Client.eth.sendSignedTransaction(signed.rawTransaction);

			console.log("Vault successfully depleted.");
		} catch(error) {
			console.log("Vault deplete tx fail", error);
		}
	}

	setInterval(() => {
		refill();
		deplete();
	}, CHECK_REFILL_SEC*1000);
}

// ------------------------------------------
// 13. AUTO HARVEST REWARDS
// ------------------------------------------

if(AUTO_HARVEST_SEC > 0){
	async function claimTokens(){
		const tx = {
			from: process.env.PUBLIC_KEY,
			to : nftRewardsContract.options.address,
			data : nftRewardsContract.methods.claimTokens().encodeABI(),
			maxPriorityFeePerGas: currentlySelectedWeb3Client.utils.toHex(standardTransactionGasFees.maxPriorityFee*1e9),
			maxFeePerGas: currentlySelectedWeb3Client.utils.toHex(standardTransactionGasFees.maxFee*1e9),
			gas: MAX_GAS_PER_TRANSACTION,
			nonce: nonceManager.getNextNonce()
		};


		try {
			const signed = await currentlySelectedWeb3Client.eth.accounts.signTransaction(tx, process.env.PRIVATE_KEY);

			await currentlySelectedWeb3Client.eth.sendSignedTransaction(signed.rawTransaction);

			console.log("Tokens claimed.");
		} catch (error) {
			console.log("claimTokens tx fail: " + error.message, error);
		};
	}

	async function claimPoolTokens(){
		let currentRound = await nftRewardsContract.methods.currentRound().call();
		currentRound = parseFloat(currentRound.toString());

		if(currentRound === 0) {
			console.log("Current round is 0, skipping claimPoolTokens for now.");

			return;
		}

		const fromRound = currentRound < 101 ? 0 : currentRound-101;
		const toRound =  currentRound - 1;

		const tx = {
			from: process.env.PUBLIC_KEY,
			to : nftRewardsContract.options.address,
			data : nftRewardsContract.methods.claimPoolTokens(fromRound, toRound).encodeABI(),
			maxPriorityFeePerGas: currentlySelectedWeb3Client.utils.toHex(standardTransactionGasFees.maxPriorityFee*1e9),
			maxFeePerGas: currentlySelectedWeb3Client.utils.toHex(standardTransactionGasFees.maxFee*1e9),
			gas: MAX_GAS_PER_TRANSACTION,
			nonce: nonceManager.getNextNonce()
		};


		try {
			const signed = await currentlySelectedWeb3Client.eth.accounts.signTransaction(tx, process.env.PRIVATE_KEY);

			await currentlySelectedWeb3Client.eth.sendSignedTransaction(signed.rawTransaction)

			console.log("Pool Tokens claimed.");
		} catch (error) {
			console.log("claimPoolTokens tx fail: " + error.message, error);
		}
	}

	setInterval(async () => {
		console.log("Harvesting rewards...");

		try
		{
			await Promise.all(
				[
					claimTokens(),
					claimPoolTokens()
				]);
		} catch (error) {
			console.log("Harvesting rewards failed unexpectedly: " + error.message, error);
		}
	}, AUTO_HARVEST_SEC*1000);
}
