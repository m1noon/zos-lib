'use strict';
require('../../setup')

import Contracts from '../../../src/utils/Contracts'
import encodeCall from '../../../src/helpers/encodeCall'
import assertRevert from '../../../src/test/helpers/assertRevert'

const Implementation1 = artifacts.require('Implementation1');
const Implementation2 = artifacts.require('Implementation2');
const Implementation3 = artifacts.require('Implementation3');
const Implementation4 = artifacts.require('Implementation4');
const MigratableMockV1 = artifacts.require('MigratableMockV1')
const MigratableMockV2 = artifacts.require('MigratableMockV2')
const MigratableMockV3 = artifacts.require('MigratableMockV3')
const MigratableMock = artifacts.require('MigratableMock')
const DummyImplementation = artifacts.require('DummyImplementation')
const ClashingImplementation = artifacts.require('ClashingImplementation')
const AdminUpgradeabilityProxy = artifacts.require('AdminUpgradeabilityProxy')

const sendTransaction = (target, method, args, values, opts) => {
  const data = encodeCall(method, args, values);
  return target.sendTransaction(Object.assign({ data }, opts));
};

contract('AdminUpgradeabilityProxy', ([_, admin, anotherAccount]) => {
  before(async function () {
    this.implementation_v0 = (await DummyImplementation.new()).address
    this.implementation_v1 = (await DummyImplementation.new()).address
  })

  beforeEach(async function () {
    this.proxy = await AdminUpgradeabilityProxy.new(this.implementation_v0, { from: admin })
    this.proxyAddress = this.proxy.address;
  })

  describe('implementation', function () {
    it('returns the current implementation address', async function () {
      const implementation = await this.proxy.implementation({ from: admin })

      implementation.should.be.equal(this.implementation_v0)
    })

    it('delegates to the implementation', async function () {
      const dummy = new DummyImplementation(this.proxyAddress);
      const value = await dummy.get();

      value.should.be.true
    })
  })

  describe('upgradeTo', function () {
    describe('when the sender is the admin', function () {
      const from = admin

      describe('when the given implementation is different from the current one', function () {
        it('upgrades to the requested implementation', async function () {
          await this.proxy.upgradeTo(this.implementation_v1, { from })

          const implementation = await this.proxy.implementation({ from: admin })
          implementation.should.be.equal(this.implementation_v1)
        })

        it('emits an event', async function () {
          const { logs } = await this.proxy.upgradeTo(this.implementation_v1, { from })

          logs.should.have.lengthOf(1)
          logs[0].event.should.be.equal('Upgraded')
          logs[0].args.implementation.should.be.equal(this.implementation_v1)
        })
      })

      describe('when the given implementation is the zero address', function () {
        it('reverts', async function () {
          await assertRevert(this.proxy.upgradeTo(0, { from }))
        })
      })
    })

    describe('when the sender is not the admin', function () {
      const from = anotherAccount

      it('reverts', async function () {
        await assertRevert(this.proxy.upgradeTo(this.implementation_v1, { from }))
      })
    })
  })

  describe('upgradeToAndCall', function () {
    describe('without migrations', function () {
      beforeEach(async function () {
        this.behavior = await MigratableMock.new()
      })

      describe('when the call does not fail', function () {
        const initializeData = encodeCall('initialize', ['uint256'], [42])

        describe('when the sender is the admin', function () {
          const from = admin
          const value = 1e5

          beforeEach(async function () {
            this.logs = (await this.proxy.upgradeToAndCall(this.behavior.address, initializeData, { from, value })).logs
          })

          it('upgrades to the requested implementation', async function () {
            const implementation = await this.proxy.implementation({ from: admin })
            implementation.should.be.equal(this.behavior.address)
          })

          it('emits an event', function () {
            this.logs.should.have.lengthOf(1)
            this.logs[0].event.should.be.equal('Upgraded')
            this.logs[0].args.implementation.should.be.equal(this.behavior.address)
          })

          it('calls the \'initialize\' function', async function() {
            const migratable = MigratableMock.at(this.proxyAddress)
            const x = await migratable.x()
            x.should.be.bignumber.eq(42)
          })

          it('sends given value to the proxy', async function() {
            const balance = await web3.eth.getBalance(this.proxyAddress)
            assert(balance.eq(value))
          })

          it('uses the storage of the proxy', async function () {
            // fetch the x value of Migratable at position 0 of the storage
            const storedValue = await web3.eth.getStorageAt(this.proxyAddress, 1);
            storedValue.should.be.bignumber.eq(42);
          })
        })

        describe('when the sender is not the admin', function () {
          const from = anotherAccount

          it('reverts', async function () {
            await assertRevert(this.proxy.upgradeToAndCall(this.behavior.address, initializeData, { from }))
          })
        })
      })

      describe('when the call does fail', function () {
        const initializeData = encodeCall('fail')

        it('reverts', async function () {
          await assertRevert(this.proxy.upgradeToAndCall(this.behavior.address, initializeData, { from: admin }))
        })
      })
    })

    describe('with migrations', function () {
      describe('when the sender is the admin', function () {
        const from = admin
        const value = 1e5

        describe('when upgrading to V1', function () {
          const v1MigrationData = encodeCall('initialize', ['uint256'], [42])

          beforeEach(async function () {
            this.behavior_v1 = await MigratableMockV1.new()
            this.balancePrevious_v1 = await web3.eth.getBalance(this.proxyAddress)
            this.logs = (await this.proxy.upgradeToAndCall(this.behavior_v1.address, v1MigrationData, { from, value })).logs
          })

          it('upgrades to the requested version and emits an event', async function () {
            const implementation = await this.proxy.implementation({ from: admin })
            implementation.should.be.equal(this.behavior_v1.address)
            this.logs.should.have.lengthOf( 1)
            this.logs[0].event.should.be.equal('Upgraded')
            this.logs[0].args.implementation.should.be.equal(this.behavior_v1.address)
          })

          it('calls the \'initialize\' function and sends given value to the proxy', async function() {
            const migratable = MigratableMockV1.at(this.proxyAddress)

            const x = await migratable.x()
            x.should.be.bignumber.eq(42)

            const balance = await web3.eth.getBalance(this.proxyAddress)
            assert(balance.eq(this.balancePrevious_v1.plus(value)))
          })

          describe('when upgrading to V2', function () {
            const v2MigrationData = encodeCall('migrate', ['uint256', 'uint256'], [10, 42])

            beforeEach(async function () {
              this.behavior_v2 = await MigratableMockV2.new()
              this.balancePrevious_v2 = await web3.eth.getBalance(this.proxyAddress)
              this.logs = (await this.proxy.upgradeToAndCall(this.behavior_v2.address, v2MigrationData, { from, value })).logs
            })

            it('upgrades to the requested version and emits an event', async function () {
              const implementation = await this.proxy.implementation({ from: admin })
              implementation.should.be.equal(this.behavior_v2.address)
              this.logs.should.have.lengthOf( 1)
              this.logs[0].event.should.be.equal('Upgraded')
              this.logs[0].args.implementation.should.be.equal(this.behavior_v2.address)
            })

            it('calls the \'migrate\' function and sends given value to the proxy', async function() {
              const migratable = MigratableMockV2.at(this.proxyAddress)

              const x = await migratable.x()
              x.should.be.bignumber.eq(10)

              const y = await migratable.y()
              y.should.be.bignumber.eq(42)

              const balance = await web3.eth.getBalance(this.proxyAddress)
              balance.should.be.bignumber.eq(this.balancePrevious_v2.plus(value))
            })

            describe('when upgrading to V3', function () {
              const v3MigrationData = encodeCall('migrate')

              beforeEach(async function () {
                this.behavior_v3 = await MigratableMockV3.new()
                this.balancePrevious_v3 = await web3.eth.getBalance(this.proxyAddress)
                this.logs = (await this.proxy.upgradeToAndCall(this.behavior_v3.address, v3MigrationData, { from, value })).logs
              })

              it('upgrades to the requested version and emits an event', async function () {
                const implementation = await this.proxy.implementation({ from: admin })
                implementation.should.be.equal(this.behavior_v3.address)
                this.logs.should.have.lengthOf( 1)
                this.logs[0].event.should.be.equal('Upgraded')
                this.logs[0].args.implementation.should.be.equal(this.behavior_v3.address)
              })

              it('calls the \'migrate\' function and sends given value to the proxy', async function() {
                const migratable = MigratableMockV3.at(this.proxyAddress)

                const x = await migratable.x()
                x.should.be.bignumber.eq(42)

                const y = await migratable.y()
                y.should.be.bignumber.eq(10)

                const balance = await web3.eth.getBalance(this.proxyAddress)
                balance.should.be.bignumber.eq(this.balancePrevious_v3.plus(value))
              })
            })
          })
        })
      })

      describe('when the sender is not the admin', function () {
        const from = anotherAccount

        it('reverts', async function () {
          const behavior_v1 = await MigratableMockV1.new()
          const v1MigrationData = encodeCall('initialize', ['uint256'], [42])
          await assertRevert(this.proxy.upgradeToAndCall(behavior_v1.address, v1MigrationData, { from }))
        })
      })
    })
  })

  describe('changeAdmin', function () {
    describe('when the new proposed admin is not the zero address', function () {
      const newAdmin = anotherAccount

      describe('when the sender is the admin', function () {
        beforeEach('transferring', async function () {
          const { logs } = await this.proxy.changeAdmin(newAdmin, { from: admin })
          this.logs = logs
        })

        it('assigns new proxy admin', async function () {
          const proxyAdmin = await this.proxy.admin({ from: newAdmin })
          proxyAdmin.should.be.equal(anotherAccount)
        })

        it('emits an event', function () {
          this.logs.should.have.lengthOf( 1)
          this.logs[0].event.should.be.equal('AdminChanged')
          this.logs[0].args.previousAdmin.should.be.equal(admin)
          this.logs[0].args.newAdmin.should.be.equal(newAdmin)
        })
      })

      describe('when the sender is not the admin', function () {
        const from = anotherAccount

        it('reverts', async function () {
          await assertRevert(this.proxy.changeAdmin(newAdmin, { from }))
        })
      })
    })

    describe('when the new proposed admin is the zero address', function () {
      const newAdmin = 0x0

      it('reverts', async function () {
        await assertRevert(this.proxy.changeAdmin(newAdmin, { from: admin }))
      })
    })
  })

  describe('storage', function () {
    it('should store the implementation address in specified location', async function () {
      const position = web3.sha3('org.zeppelinos.proxy.implementation');
      const implementation = await web3.eth.getStorageAt(this.proxyAddress, position);

      implementation.should.be.equal(this.implementation_v0);
    })

    it('should store the admin proxy in specified location', async function () {
      const position = web3.sha3('org.zeppelinos.proxy.admin');
      const proxyAdmin = await web3.eth.getStorageAt(this.proxyAddress, position);

      proxyAdmin.should.be.equal(admin);
    })
  })

  describe('transparent proxy', function () {
    beforeEach('creating proxy', async function () {
      this.impl = await ClashingImplementation.new();
      this.proxy = await AdminUpgradeabilityProxy.new(this.impl.address, { from: admin });

      this.clashing = ClashingImplementation.at(this.proxy.address);
    });

    it('proxy admin cannot call delegated functions', async function () {
      await assertRevert(this.clashing.delegatedFunction({ from: admin }));
    });

    context('when function names clash', function () {
      it('when sender is proxy admin should run the proxy function', async function () {
        const value = await this.proxy.admin({ from: admin });
        value.should.be.equal(admin);
      });

      it('when sender is other should delegate to implementation', async function () {
        const value = await this.proxy.admin({ from: anotherAccount });
        value.should.be.equal('0x0000000000000000000000000000000011111142')
      });
    });
  });

  describe('regression', () => {
    it('should add new function', async () => {
      const instance1 = await Implementation1.new();

      const proxy = await AdminUpgradeabilityProxy.new(instance1.address, {
        from: admin
      });

      const proxyInstance1 = await Implementation1.at(proxy.address);
      await proxyInstance1.setValue(42);

      const instance2 = await Implementation2.new();
      await proxy.upgradeTo(instance2.address, {
        from: admin
      });

      const proxyInstance2 = Implementation2.at(proxy.address);
      const res = await proxyInstance2.getValue();
      assert.equal(res.toString(), "42");
    });

    it('should remove function', async () => {
      const instance2 = await Implementation2.new();

      const proxy = await AdminUpgradeabilityProxy.new(instance2.address, {
        from: admin
      });

      const proxyInstance2 = await Implementation2.at(proxy.address);
      await proxyInstance2.setValue(42);
      const res = await proxyInstance2.getValue();
      assert.equal(res.toString(), "42");

      const instance1 = await Implementation1.new();

      await proxy.upgradeTo(instance1.address, {
        from: admin
      });

      const proxyInstance1 = await Implementation2.at(proxy.address);
      assertRevert(proxyInstance1.getValue());
    });

    it('should change function signature', async () => {
      const instance1 = await Implementation1.new();

      const proxy = await AdminUpgradeabilityProxy.new(instance1.address, {
        from: admin
      });

      const proxyInstance1 = await Implementation1.at(proxy.address);
      await proxyInstance1.setValue(42);

      const instance3 = await Implementation3.new();
      await proxy.upgradeTo(instance3.address, {
        from: admin
      });

      const proxyInstance3 = Implementation3.at(proxy.address);
      const res = await proxyInstance3.getValue(8);
      assert.equal(res.toString(), "50");
    });

    it('should add fallback function', async () => {
      const instance1 = await Implementation1.new();

      const proxy = await AdminUpgradeabilityProxy.new(instance1.address, {
        from: admin
      });
      const proxyInstance1 = await Implementation1.at(proxy.address);

      const instance4 = await Implementation4.new();
      await proxy.upgradeTo(instance4.address, {
        from: admin
      });

      const proxyInstance4 = await Implementation4.at(proxy.address);

      await sendTransaction(proxy, '', [], [], {
        from: anotherAccount
      });

      const res = await proxyInstance4.getValue();
      assert.equal(res.toString(), "1");
    });

    it('should remove fallback function', async () => {
      const instance4 = await Implementation4.new();
      const proxy = await AdminUpgradeabilityProxy.new(instance4.address, {
        from: admin
      });
      const proxyInstance4 = await Implementation4.at(proxy.address);

      const instance2 = await Implementation2.new();
      await proxy.upgradeTo(instance2.address, {
        from: admin
      });

      await assertRevert(sendTransaction(proxy, '', [], [], {
        from: anotherAccount
      }));

      const proxyInstance2 = Implementation2.at(proxy.address);

      const res = await proxyInstance2.getValue();
      assert.equal(res.toString(), "0");
    });
  });
})
