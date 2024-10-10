/*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
* http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

'use strict';

const chai = require('chai');
chai.should();
const chaiAsPromised = require('chai-as-promised');
chai.use(chaiAsPromised);
const sinon = require('sinon');
const mockery = require('mockery');

const MessengerInterface = require('../../lib/common/messengers/messenger-interface');
const ConnectorInterface = require('../../lib/common/core/connector-interface');
const TestMessage = require('../../lib/common/messages/testMessage');
const RateInterface = require('../../lib/worker/rate-control/rateInterface');
const WorkloadInterface = require('../../lib/worker/workload/workloadModuleInterface');
const TransactionStatisticsCollector = require('../../lib/common/core/transaction-statistics-collector');

const mockRate = sinon.createStubInstance(RateInterface);
const mockWorkload = sinon.createStubInstance(WorkloadInterface);
const mockStats = sinon.createStubInstance(TransactionStatisticsCollector);
mockStats.getTotalSubmittedTx.onFirstCall().returns(0);
mockStats.getTotalSubmittedTx.onSecondCall().returns(1);
const deactivateMethod = sinon.stub();
let logwarningMethod = sinon.stub();
let logerrorMethod =  sinon.stub();

class MockCaliperUtils {
    static resolvePath(path) {
        return 'fake/path';
    }

    static loadModuleFunction(map, a,b,c,d) {
        let mock = mockWorkload;
        if (map.size > 0) {
            mock = mockRate;
        }
        return () => {
            return mock;
        };
    }

    static getLogger() {
        return {
            debug: sinon.stub(),
            error: logerrorMethod,
            warn: logwarningMethod,
            info: sinon.stub()
        };
    }

    static sleep() {}
}

class MockInternalTxObserver {
    getCurrentStatistics() {
        return mockStats;
    }
}

class MockTxObserverDispatch {
    activate() {}
}

/**
 * Mock implementation of the RateControl class used for testing.
 * Provides stub methods for rate control operations.
 */
class MockRateControl {
    /**
     * Cleans up the rate controller.
     * This mock method simulates the cleanup process.
     * @async
     * @returns {Promise<void>} A promise that resolves when the cleanup is complete.
     */
    async end() {
        // Mock cleanup logic (if any)
    }

    /**
     * Applies rate control to throttle the transaction submission rate.
     * This mock method simulates rate control with a delay.
     * @async
     * @returns {Promise<void>} A promise that resolves after a delay.
     */
    async applyRateControl(delay = 10) {
        await new Promise(resolve => setTimeout(resolve, delay));
    }
}


MockTxObserverDispatch.prototype.deactivate = deactivateMethod;

mockery.enable({
    warnOnReplace: false,
    warnOnUnregistered: false,
    useCleanCache: true
});
mockery.registerMock('./tx-observers/internal-tx-observer', MockInternalTxObserver);
mockery.registerMock('./tx-observers/tx-observer-dispatch', MockTxObserverDispatch);

const loggerSandbox = sinon.createSandbox();
const CaliperUtils = require('../../lib/common/utils/caliper-utils');
loggerSandbox.replace(CaliperUtils, 'getLogger', MockCaliperUtils.getLogger);

const CaliperWorker = require('../../lib/worker/caliper-worker');

describe('Caliper worker', () => {
    after(() => {
        loggerSandbox.restore();
    });

    describe('When executing a round', () => {
        let mockConnector, mockMessenger, mockTestMessage;
        const sandbox = sinon.createSandbox();

        beforeEach(() => {
            logwarningMethod.reset();
            mockRate.end.reset();
            mockWorkload.cleanupWorkloadModule.reset();
            mockWorkload.submitTransaction.reset();
            mockStats.getTotalSubmittedTx.resetHistory();
            deactivateMethod.reset();

            mockConnector = sinon.createStubInstance(ConnectorInterface);
            mockConnector.getContext.resolves(1);
            mockMessenger = sinon.createStubInstance(MessengerInterface);
            mockTestMessage = sinon.createStubInstance(TestMessage);
            mockTestMessage.getRateControlSpec.returns({type: '1zero-rate'});
            mockTestMessage.getWorkloadSpec.returns({module: 'test/workload'});
            mockTestMessage.getNumberOfTxs.returns(1);
            sandbox.replace(CaliperUtils, 'resolvePath', MockCaliperUtils.resolvePath);
            sandbox.replace(CaliperUtils, 'loadModuleFunction', MockCaliperUtils.loadModuleFunction);
            sandbox.replace(CaliperUtils, 'sleep', MockCaliperUtils.sleep);
        });

        afterEach(() => {
            sandbox.restore();
        });

        const validateCallsAndWarnings = (warnings) => {
            sinon.assert.calledOnce(mockWorkload.submitTransaction);
            sinon.assert.calledOnce(deactivateMethod);
            sinon.assert.calledOnce(mockRate.end);
            sinon.assert.calledOnce(mockWorkload.cleanupWorkloadModule);
            sinon.assert.calledTwice(mockConnector.releaseContext);
            sinon.assert.callCount(logwarningMethod, warnings);
        };

        it('should clean up all resources if a connector does not throw an error', async () => {
            const worker = new CaliperWorker(mockConnector, 1, mockMessenger, 'uuid');
            await worker.prepareTest(mockTestMessage);
            mockWorkload.submitTransaction.resolves();

            await worker.executeRound(mockTestMessage);
            validateCallsAndWarnings(0);
        });


        it('should clean up all resources if a connector throws an error', async () => {
            const worker = new CaliperWorker(mockConnector, 1, mockMessenger, 'uuid');
            await worker.prepareTest(mockTestMessage);
            mockWorkload.submitTransaction.rejects(new Error('failure'));

            await worker.executeRound(mockTestMessage).should.be.rejected;
            validateCallsAndWarnings(0);
        });

        it('should warn if any of the cleanup tasks fail', async () => {
            const worker = new CaliperWorker(mockConnector, 1, mockMessenger, 'uuid');
            await worker.prepareTest(mockTestMessage);
            mockWorkload.submitTransaction.resolves();
            deactivateMethod.rejects(new Error('deactivate error'));
            mockRate.end.rejects(new Error('rate end error'));
            mockWorkload.cleanupWorkloadModule.rejects(new Error('cleanup error'));
            mockConnector.releaseContext.rejects(new Error('release error'));

            await worker.executeRound(mockTestMessage);
            validateCallsAndWarnings(4);
        });

        [5, 10].forEach(numberOfTxs => {
            it(`should run ${numberOfTxs} transactions and wait for completion when no errors occur`, async () => {
                const worker = new CaliperWorker(mockConnector, 1, mockMessenger, 'uuid');
                await worker.prepareTest(mockTestMessage);

                mockTestMessage.getNumberOfTxs.returns(numberOfTxs);
                mockTestMessage.getRoundDuration.returns(null);

                mockWorkload.submitTransaction.resetHistory();
                mockStats.getTotalSubmittedTx.resetHistory();
                mockStats.getTotalFinishedTx.resetHistory();
                mockStats.getCumulativeTxStatistics.resetHistory();

                let submittedTx = 0;
                let finishedTx = 0;

                // Stub the methods
                mockStats.getTotalSubmittedTx.callsFake(() => submittedTx);
                mockStats.getTotalFinishedTx.callsFake(() => finishedTx);
                mockStats.getCumulativeTxStatistics.returns({});

                worker.internalTxObserver.getCurrentStatistics = () => mockStats;

                mockWorkload.submitTransaction.callsFake(async () => {
                    submittedTx += 1;
                    finishedTx += 1;
                    return Promise.resolve();
                });

                await worker.executeRound(mockTestMessage);

                sinon.assert.callCount(mockWorkload.submitTransaction, numberOfTxs);
                sinon.assert.calledOnce(deactivateMethod);
                sinon.assert.calledOnce(mockRate.end);
                sinon.assert.calledOnce(mockWorkload.cleanupWorkloadModule);
                sinon.assert.called(mockConnector.releaseContext);
            });
        });

        it('should execute the round for a specified duration', async function() {
            this.timeout(5000); // Increase the timeout for this test
            const worker = new CaliperWorker(mockConnector, 1, mockMessenger, 'uuid');
            await worker.prepareTest(mockTestMessage);
            mockWorkload.submitTransaction.resolves();
            mockTestMessage.getRoundDuration.returns(1); // duration in seconds

            await worker.executeRound(mockTestMessage);

            sinon.assert.calledOnce(deactivateMethod);
            sinon.assert.calledOnce(mockRate.end);
            sinon.assert.calledOnce(mockWorkload.cleanupWorkloadModule);
            sinon.assert.called(mockConnector.releaseContext);
        });


        it('should handle errors during the prepareTest phase', async () => {
            const worker = new CaliperWorker(mockConnector, 1, mockMessenger, 'uuid');
            const errorMessage = 'Initialization error';
            mockConnector.getContext.rejects(new Error(errorMessage));
            mockTestMessage.getRoundIndex.returns(1);
            mockTestMessage.getWorkloadSpec.returns({ module: 'test/workload' });
            mockTestMessage.getWorkerArguments.returns([]);

            await worker.prepareTest(mockTestMessage).should.be.rejectedWith(errorMessage);

            sinon.assert.calledOnce(mockConnector.getContext);
            sinon.assert.calledOnce(logwarningMethod);
        });

        it('should not submit transactions after the duration ends', async function() {
            this.timeout(5000);

            const worker = new CaliperWorker(mockConnector, 1, mockMessenger, 'uuid');
            await worker.prepareTest(mockTestMessage);

            const clock = sinon.useFakeTimers();
            mockWorkload.submitTransaction.resolves();

            mockTestMessage.getRoundDuration.returns(1);
            mockTestMessage.getNumberOfTxs.returns(null);

            const executePromise = worker.executeRound(mockTestMessage);

            await clock.tickAsync(1000); // Advance time by 1 second
            await Promise.resolve();

            const callCountAtDurationEnd = mockWorkload.submitTransaction.callCount;

            await clock.tickAsync(1000); // Advance time by another second
            await executePromise;

            clock.restore();

            sinon.assert.callCount(mockWorkload.submitTransaction, callCountAtDurationEnd);
        });
    });
});
