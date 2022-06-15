const Algorithms = require('./algorithms');
const Template = require('./template');
const events = require('events');
const fastRoot = require('merkle-lib/fastRoot');
const utils = require('./utils');

////////////////////////////////////////////////////////////////////////////////

// Main Manager Function
const Manager = function(config, configMain) {

  const _this = this;
  this.config = config;
  this.configMain = configMain;

  // Job Variables
  this.validJobs = {};
  this.jobCounter = utils.jobCounter();
  this.currentJob = null;

  // ExtraNonce Variables
  this.extraNonceCounter = utils.extraNonceCounter(2);
  this.extraNoncePlaceholder = Buffer.from('f000', 'hex');
  this.extraNonce2Size = _this.extraNoncePlaceholder.length - _this.extraNonceCounter.size;

  // Check if New Block is Processed
  this.handleTemplate = function(rpcData, newBlock) {

    // If Current Job !== Previous Job
    let isNewBlock = _this.currentJob === null;
    if (!isNewBlock && rpcData.height >= _this.currentJob.rpcData.height &&
        ((_this.currentJob.rpcData.previousblockhash !== rpcData.previousblockhash) ||
        (_this.currentJob.rpcData.bits !== rpcData.bits))) {
      isNewBlock = true;
    }

    // Build New Block Template
    if (!isNewBlock && !newBlock) return false;
    const tmpTemplate = new Template(
      _this.jobCounter.next(),
      _this.config,
      Object.assign({}, rpcData),
      _this.extraNoncePlaceholder);

    // Update Current Template
    _this.validJobs = {};
    _this.currentJob = tmpTemplate;
    _this.emit('manager.block.new', tmpTemplate);
    _this.validJobs[tmpTemplate.jobId] = tmpTemplate;
    return true;
  };

  // Process Submitted Share
  this.handleShare = function(
    jobId, previousDifficulty, difficulty, ipAddress, port, addrPrimary,
    addrAuxiliary, submission) {

    // Main Submission Variables
    const identifier = _this.configMain.identifier || '';
    const submitTime = Date.now() / 1000 | 0;
    const job = _this.validJobs[jobId];

    // Establish Hashing Algorithms
    const hashDigest = Algorithms.firopow.hash();
    const headerDigest = Algorithms.sha256d.hash();
    const coinbaseDigest = Algorithms.sha256d.hash();
    const blockDigest = Algorithms.sha256d.hash();

    // Share is Invalid
    const shareError = function(error) {
      _this.emit('manager.share', {
        job: jobId,
        ip: ipAddress,
        port: port,
        addrPrimary: addrPrimary,
        addrAuxiliary: addrAuxiliary,
        difficulty: difficulty,
        identifier: identifier,
        error: error[1],
      }, false);
      return { error: error, response: null };
    };

    // Edge Cases to Check if Share is Invalid
    if (typeof job === 'undefined' || job.jobId != jobId) {
      return shareError([21, 'job not found']);
    }
    if (!utils.isHexString(submission.headerHash)) {
      return shareError([20, 'invalid header submission [1]']);
    }
    if (!utils.isHexString(submission.mixHash)) {
      return shareError([20, 'invalid mixHash submission']);
    }
    if (!utils.isHexString(submission.nonce)) {
      return shareError([20, 'invalid nonce submission']);
    }
    if (submission.mixHash.length !== 64) {
      return shareError([20, 'incorrect size of mixHash']);
    }
    if (submission.nonce.length !== 16) {
      return shareError([20, 'incorrect size of nonce']);
    }
    if (submission.nonce.indexOf(submission.extraNonce1.substring(0, 4)) !== 0) {
      return shareError([24, 'nonce out of worker range']);
    }
    if (!addrPrimary) {
      return shareError([20, 'worker address isn\'t set properly']);
    }
    if (!job.registerSubmit([submission.extraNonce1, submission.nonce, submission.headerHash, submission.mixHash])) {
      return shareError([22, 'duplicate share']);
    }

    // Establish Share Information
    let blockValid = false;
    let version = job.rpcData.version;
    const extraNonce1Buffer = Buffer.from(submission.extraNonce1, 'hex');
    const nonceBuffer = utils.reverseBuffer(Buffer.from(submission.nonce, 'hex'));
    const mixHashBuffer = Buffer.from(submission.mixHash, 'hex');

    // Generate Coinbase Buffer
    const coinbaseBuffer = job.handleCoinbase(extraNonce1Buffer);
    const coinbaseHash = coinbaseDigest(coinbaseBuffer);
    const hashes = utils.convertHashToBuffer(job.rpcData.transactions);
    const transactions = [coinbaseHash].concat(hashes);
    const merkleRoot = fastRoot(transactions, utils.sha256d);

    // Start Generating Block Hash
    const nTime = utils.packUInt32BE(job.rpcData.curtime).toString('hex');
    const headerBuffer = job.handleHeader(version, merkleRoot, nTime);
    const headerHashBuffer = utils.reverseBuffer(headerDigest(headerBuffer));
    const headerHash = headerHashBuffer.toString('hex');

    // Check if Generated Header Matches
    if (submission.headerHash !== headerHash) {
      return shareError([20, 'invalid header submission [2]']);
    }

    // Check Validity of Solution
    const hashOutputBuffer = Buffer.alloc(32);
    const isValid = hashDigest(headerHashBuffer, nonceBuffer, job.rpcData.height, mixHashBuffer, hashOutputBuffer);
    const headerBigInt = utils.bufferToBigInt(headerHash);

    // Check if Submission is Valid Solution
    if (!isValid) {
      return shareError([20, 'submission is not valid']);
    }

    // Calculate Share Difficulty
    const shareMultiplier = Algorithms.firopow.multiplier;
    const shareDiff = Algorithms.firopow.diff / Number(headerBigInt) * shareMultiplier;
    const blockDiffAdjusted = job.difficulty * Algorithms.firopow.multiplier;

    // Combine Header/Merkle/Nonce Buffers
    const combinedBuffer = Buffer.alloc(120);
    headerBuffer.copy(combinedBuffer);
    merkleRoot.copy(combinedBuffer, 36);
    nonceBuffer.copy(combinedBuffer, 80);
    utils.reverseBuffer(mixHashBuffer).copy(combinedBuffer, 88);

    // Generate Output Block Hash/Hex
    const blockHash = utils.reverseBuffer(blockDigest(combinedBuffer)).toString('hex');
    const blockHex = job.handleBlocks(headerBuffer, coinbaseBuffer, nonceBuffer, mixHashBuffer).toString('hex');

    // Check if Share is Valid Block Candidate
    if (job.target >= headerBigInt) {
      blockValid = true;
    } else {
      if (shareDiff / difficulty < 0.99) {
        if (previousDifficulty && shareDiff >= previousDifficulty) {
          difficulty = previousDifficulty;
        } else {
          return shareError([23, 'low difficulty share of ' + shareDiff]);
        }
      }
    }

    // Build Primary Share Object Data
    const shareData = {
      job: jobId,
      ip: ipAddress,
      port: port,
      addrPrimary: addrPrimary,
      addrAuxiliary: addrAuxiliary,
      blockDiffPrimary : blockDiffAdjusted,
      blockType: blockValid ? 'primary' : 'share',
      coinbase: coinbaseBuffer,
      difficulty: difficulty,
      hash: blockHash,
      hex: blockHex,
      header: headerHash,
      headerDiff: headerBigInt,
      height: job.rpcData.height,
      identifier: identifier,
      reward: job.rpcData.coinbasevalue,
      shareDiff: shareDiff.toFixed(8),
    };

    const auxShareData = {
      job: jobId,
      ip: ipAddress,
      port: port,
      addrPrimary: addrPrimary,
      addrAuxiliary: addrAuxiliary,
      blockDiffPrimary : blockDiffAdjusted,
      blockType: 'auxiliary',
      coinbase: coinbaseBuffer,
      difficulty: difficulty,
      hash: blockHash,
      hex: blockHex,
      header: headerHash,
      headerDiff: headerBigInt,
      identifier: identifier,
      shareDiff: shareDiff.toFixed(8),
    };

    _this.emit('manager.share', shareData, auxShareData, blockValid);
    return { error: null, hash: blockHash, hex: blockHex, response: true };
  };
};

module.exports = Manager;
Manager.prototype.__proto__ = events.EventEmitter.prototype;
